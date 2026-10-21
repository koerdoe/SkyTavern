// 资料存储：每份资料一行 JSONB。第一次访问时写入默认资料。

import type { DatabaseSync } from 'node:sqlite';
import {
  applyLibraryOps,
  checkDoc,
  checkSettings,
  defaultLibrary,
  ID_PREFIX,
  LibraryError,
  upgradeDoc,
  type Character,
  type LibraryDocs,
  type LibraryKind,
  type LibraryOp,
  type UserSettings,
} from '../../core/library.ts';
import type { LibrarySummary } from '../../core/views.ts';

export type { LibrarySummary };

const notFound = (kind: string, id: string): LibraryError => new LibraryError('not-found', `${kind} ${id} 不存在`);

export class LibraryStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly seeded = new Set<string>();

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  list(user: string, kind: LibraryKind): LibrarySummary[] {
    this.seed(user);
    const rows = this.db
      .prepare(
        `SELECT id, updated_at AS updatedAt, json_extract(doc, '$.name') AS name,
                json_extract(doc, '$.tags') AS tags, json_extract(doc, '$.favorite') AS favorite,
                json_extract(doc, '$.avatar') AS avatar, json_extract(doc, '$.use') AS use
           FROM library WHERE user = ? AND kind = ? ORDER BY updated_at DESC`,
      )
      .all(user, kind) as unknown as { id: string; updatedAt: number; name: string; tags: string | null; favorite: number | null; avatar: string | null; use: string | null }[];
    return rows.map((r) =>
      kind === 'character'
        ? { id: r.id, name: r.name, updatedAt: r.updatedAt, tags: JSON.parse(r.tags ?? '[]') as string[], favorite: r.favorite === 1, avatar: r.avatar ?? null }
        : kind === 'model'
          ? { id: r.id, name: r.name, updatedAt: r.updatedAt, use: r.use === 'embedding' ? ('embedding' as const) : ('chat' as const) }
          : { id: r.id, name: r.name, updatedAt: r.updatedAt },
    );
  }

  get<K extends LibraryKind>(user: string, kind: K, id: string): LibraryDocs[K] {
    this.seed(user);
    const row = this.db.prepare('SELECT json(doc) AS doc FROM library WHERE user = ? AND kind = ? AND id = ?').get(user, kind, id) as
      | { doc: string }
      | undefined;
    if (!row) throw notFound(kind, id);
    return upgradeDoc(kind, JSON.parse(row.doc) as Record<string, unknown>);
  }

  /** 新建：分配容器ID，词条ID 按新容器重新编号。 */
  create<K extends LibraryKind>(user: string, kind: K, input: Record<string, unknown>): LibraryDocs[K] {
    this.seed(user);
    const id = `${ID_PREFIX[kind]}${this.nextCounter(user, kind)}`;
    const raw: Record<string, unknown> = { ...input, id };
    if (kind !== 'model') {
      const entries = Array.isArray(input.entries) ? (input.entries as Record<string, unknown>[]) : [];
      raw.entries = entries.map((e, i) => ({ ...e, id: `${id}-${i + 1}` }));
      raw.nextEntryId = entries.length + 1;
      if (kind === 'preset' || kind === 'character') {
        const scripts = Array.isArray(input.scripts) ? (input.scripts as Record<string, unknown>[]) : [];
        raw.scripts = scripts.map((sc, i) => ({ ...sc, id: `${id}-s${i + 1}` }));
        raw.nextScriptId = scripts.length + 1;
      }
    }
    const doc = checkDoc(kind, raw);
    this.write(user, kind, doc, true);
    return doc;
  }

  /** 整份替换（JSON 模式）。模型配置未提供 apiKey 时保留原值。 */
  replace<K extends LibraryKind>(user: string, kind: K, id: string, input: Record<string, unknown>): LibraryDocs[K] {
    const old = this.get(user, kind, id) as unknown as Record<string, unknown>;
    const raw: Record<string, unknown> = { ...input, id };
    if (kind === 'model' && input.apiKey === undefined) raw.apiKey = old.apiKey;
    if (kind !== 'model') raw.nextEntryId = Math.max(Number(old.nextEntryId), Number(input.nextEntryId ?? 0));
    // 头像只由头像接口修改
    if (kind === 'character') raw.avatar = old.avatar ?? null;
    const doc = checkDoc(kind, raw);
    this.write(user, kind, doc, false);
    return doc;
  }

  patch<K extends LibraryKind>(user: string, kind: K, id: string, ops: readonly LibraryOp[]): LibraryDocs[K] {
    const doc = applyLibraryOps(kind, this.get(user, kind, id), ops);
    this.write(user, kind, doc, false);
    return doc;
  }

  // ---------- 头像 ----------

  /** 保存角色卡头像（原图），返回新的版本号并写进角色卡。 */
  setAvatar(user: string, characterId: string, mime: string, data: Uint8Array): string {
    const doc = this.get(user, 'character', characterId);
    const now = this.now();
    const version = now.toString(36);
    this.db
      .prepare(
        `INSERT INTO avatars (user, character_id, mime, data, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user, character_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(user, characterId, mime, data, now);
    this.write(user, 'character', { ...doc, avatar: version }, false);
    return version;
  }

  avatar(user: string, characterId: string): { mime: string; data: Uint8Array; updatedAt: number } | undefined {
    const row = this.db.prepare('SELECT mime, data, updated_at AS updatedAt FROM avatars WHERE user = ? AND character_id = ?').get(user, characterId) as
      | { mime: string; data: Uint8Array; updatedAt: number }
      | undefined;
    return row;
  }

  removeAvatar(user: string, characterId: string): void {
    const doc = this.get(user, 'character', characterId);
    this.db.prepare('DELETE FROM avatars WHERE user = ? AND character_id = ?').run(user, characterId);
    this.write(user, 'character', { ...doc, avatar: null }, false);
  }

  /** 被引用的角色卡、世界书不能删除，列出引用位置。 */
  delete(user: string, kind: LibraryKind, id: string): void {
    this.get(user, kind, id);
    const refs = this.references(user, kind, id);
    if (refs.length > 0) throw new LibraryError('in-use', `仍被引用，不能删除：${refs.join('；')}`);
    this.db.prepare('DELETE FROM library WHERE user = ? AND kind = ? AND id = ?').run(user, kind, id);
    if (kind === 'character') this.db.prepare('DELETE FROM avatars WHERE user = ? AND character_id = ?').run(user, id);
    const s = this.settings(user);
    const cleared: UserSettings = {
      ...s,
      presetId: s.presetId === id ? null : s.presetId,
      modelId: s.modelId === id ? null : s.modelId,
      personaId: s.personaId === id ? null : s.personaId,
    };
    this.saveSettings(user, cleared);
  }

  references(user: string, kind: LibraryKind, id: string): string[] {
    const refs: string[] = [];
    if (kind === 'character') {
      const { n } = this.db.prepare('SELECT count(*) AS n FROM sessions WHERE user = ? AND character_id = ?').get(user, id) as { n: number };
      if (n > 0) refs.push(`${n} 个会话`);
    }
    if (kind === 'worldbook') {
      for (const c of this.list(user, 'character')) {
        if (this.get(user, 'character', c.id).worldbookIds.includes(id)) refs.push(`角色卡 ${c.name}（${c.id}）`);
      }
      if (this.settings(user).worldbookIds.includes(id)) refs.push('当前打开的世界书');
    }
    return refs;
  }

  settings(user: string): UserSettings {
    this.seed(user);
    const row = this.db.prepare('SELECT json(doc) AS doc FROM settings WHERE user = ?').get(user) as { doc: string };
    // 经过校验补齐新增字段（例如旧数据没有 ui）。
    return checkSettings(JSON.parse(row.doc));
  }

  saveSettings(user: string, input: unknown): UserSettings {
    const s = checkSettings(input);
    for (const [kind, id] of [
      ['preset', s.presetId],
      ['model', s.modelId],
      ['persona', s.personaId],
      ...s.worldbookIds.map((w) => ['worldbook', w] as const),
    ] as const) {
      if (id !== null) this.get(user, kind, id);
    }
    this.db
      .prepare('INSERT INTO settings (user, doc) VALUES (?, jsonb(?)) ON CONFLICT (user) DO UPDATE SET doc = excluded.doc')
      .run(user, JSON.stringify(s));
    return s;
  }

  /** 角色卡关联的世界书 + 额外打开的世界书，去重。 */
  activeWorldbookIds(user: string, character: Character): string[] {
    return [...new Set([...character.worldbookIds, ...this.settings(user).worldbookIds])];
  }

  private write(user: string, kind: LibraryKind, doc: LibraryDocs[LibraryKind], insert: boolean): void {
    const sql = insert
      ? 'INSERT INTO library (user, kind, id, updated_at, doc) VALUES (?, ?, ?, ?, jsonb(?))'
      : 'UPDATE library SET updated_at = ?4, doc = jsonb(?5) WHERE user = ?1 AND kind = ?2 AND id = ?3';
    this.db.prepare(sql).run(user, kind, doc.id, this.now(), JSON.stringify(doc));
  }

  private nextCounter(user: string, kind: LibraryKind): number {
    const row = this.db
      .prepare(
        `INSERT INTO counters (user, name, value) VALUES (?, ?, 1)
         ON CONFLICT (user, name) DO UPDATE SET value = value + 1 RETURNING value`,
      )
      .get(user, kind) as { value: number };
    return row.value;
  }

  /** 第一次访问时写入默认资料（每个账号只做一次）。 */
  private seed(user: string): void {
    if (this.seeded.has(user)) return;
    this.seeded.add(user);
    if (this.db.prepare('SELECT 1 FROM settings WHERE user = ?').get(user)) return;
    const d = defaultLibrary();
    this.db.exec('BEGIN');
    try {
      // 计数器从已写入的条数继续，之后新建的 ID 不会撞上内置资料
      for (const [kind, docs] of [
        ['preset', d.presets],
        ['character', d.characters],
        ['persona', d.personas],
        ['worldbook', d.worldbooks],
      ] as const) {
        for (const doc of docs) this.write(user, kind, doc, true);
        this.db.prepare('INSERT INTO counters (user, name, value) VALUES (?, ?, ?)').run(user, kind, docs.length);
      }
      this.db.prepare('INSERT INTO settings (user, doc) VALUES (?, jsonb(?))').run(user, JSON.stringify(d.settings));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      this.seeded.delete(user);
      throw e;
    }
  }
}
