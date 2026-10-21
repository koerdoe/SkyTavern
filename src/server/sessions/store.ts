// 会话存储：一行一个会话，整份文档存为 JSONB；打开过的会话常驻内存。
// 每次修改都立即整份写回，所以从内存中移出总是安全的。

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { emptySession, linearize, locate, parseSessionDoc, serializeSessionDoc, type SessionDoc } from '../../core/session.ts';
import type { SessionMeta } from '../../core/views.ts';

export type { SessionMeta };

export interface LoadedSession {
  meta: SessionMeta;
  doc: SessionDoc;
}

export class SessionNotFound extends Error {
  constructor(id: string) {
    super(`会话不存在：${id}`);
    this.name = 'SessionNotFound';
  }
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** 由创建时间、角色、序号（和冲突时的扰动值）映射成 16 位字母数字。 */
export function sessionIdFrom(createdAt: number, characterId: string, seq: number, salt: number): string {
  let n = BigInt(`0x${createHash('sha256').update(`${createdAt}|${characterId}|${seq}|${salt}`).digest('hex')}`);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += BASE62[Number(n % 62n)];
    n /= 62n;
  }
  return out;
}

interface Row {
  id: string;
  user: string;
  character_id: string;
  created_at: number;
  last_active_at: number;
  parent_id: string | null;
  branch_from: string | null;
  title: string;
  layer_count: number;
  last_text: string;
}

const toMeta = (r: Row): SessionMeta => ({
  id: r.id,
  user: r.user,
  characterId: r.character_id,
  createdAt: r.created_at,
  lastActiveAt: r.last_active_at,
  parentId: r.parent_id,
  branchFrom: r.branch_from,
  title: r.title,
  layerCount: r.layer_count,
  lastText: r.last_text,
});

const META_COLS = 'id, user, character_id, created_at, last_active_at, parent_id, branch_from, title, layer_count, last_text';
export const TITLE_LIMIT = 60;
const LAST_TEXT_LIMIT = 80;

/** 列表摘要：层数和最后一条消息的开头（去掉换行和多余空白）。 */
function summarize(doc: SessionDoc): { layerCount: number; lastText: string } {
  const last = linearize(doc).at(-1);
  const text = (last?.content ?? '').replace(/\s+/g, ' ').trim();
  return { layerCount: doc.layers.length, lastText: [...text].slice(0, LAST_TEXT_LIMIT).join('') };
}

export class SessionStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly resident = new Map<string, { s: LoadedSession; touchedAt: number }>();

  /** 会话文档写回之后 / 会话删除之后（例如更新附件的引用关系）。 */
  private readonly onWritten: ((user: string, id: string, doc: SessionDoc | null) => void) | undefined;

  constructor(db: DatabaseSync, opts: { now?: () => number; idleMs?: number; onWritten?: (user: string, id: string, doc: SessionDoc | null) => void } = {}) {
    this.db = db;
    this.now = opts.now ?? Date.now;
    this.idleMs = opts.idleMs ?? 30 * 60_000;
    this.onWritten = opts.onWritten;
  }

  /** 新建会话；branch 给出时是从另一个会话分支出来的，doc 是复制好的正文。 */
  create(user: string, characterId: string, branch?: { parentId: string; branchFrom: string; doc: SessionDoc; title: string }): LoadedSession {
    const createdAt = this.now();
    const { n: seq } = this.db
      .prepare('SELECT count(*) AS n FROM sessions WHERE user = ? AND character_id = ?')
      .get(user, characterId) as { n: number };
    const exists = this.db.prepare('SELECT 1 FROM sessions WHERE id = ?');
    let salt = 0;
    let id = sessionIdFrom(createdAt, characterId, seq, salt);
    while (exists.get(id) !== undefined) id = sessionIdFrom(createdAt, characterId, seq, ++salt);

    const doc = branch?.doc ?? emptySession();
    const sum = summarize(doc);
    const s: LoadedSession = {
      meta: {
        id,
        user,
        characterId,
        createdAt,
        lastActiveAt: createdAt,
        parentId: branch?.parentId ?? null,
        branchFrom: branch?.branchFrom ?? null,
        title: branch?.title ?? '',
        ...sum,
      },
      doc,
    };
    this.db
      .prepare(`INSERT INTO sessions (${META_COLS}, doc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, jsonb(?))`)
      .run(id, user, characterId, createdAt, createdAt, s.meta.parentId, s.meta.branchFrom, s.meta.title, sum.layerCount, sum.lastText, serializeSessionDoc(doc));
    this.keep(s);
    this.onWritten?.(user, id, doc);
    return s;
  }

  /**
   * 从某条消息分支：复制到这条消息为止的全部层（含各层的全部候选、变量操作、附加消息），
   * 分支点那一层选用这条消息。新会话挂在原会话下面，形成会话树。
   */
  branch(user: string, id: string, messageId: string): LoadedSession {
    const src = this.get(user, id);
    const { layer, index } = locate(src.doc, messageId);
    const doc: SessionDoc = {
      v: 1,
      layers: structuredClone(src.doc.layers.slice(0, layer + 1)),
      recentOps: [],
      selected: [...src.doc.selected.slice(0, layer), index],
    };
    return this.create(user, src.meta.characterId, { parentId: id, branchFrom: messageId, doc, title: '' });
  }

  /** 改名；空字符串表示恢复成按时间显示。 */
  rename(user: string, id: string, title: string): SessionMeta {
    const s = this.get(user, id);
    const clean = [...title.replace(/\s+/g, ' ').trim()].slice(0, TITLE_LIMIT).join('');
    this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(clean, id);
    s.meta.title = clean;
    return s.meta;
  }

  /** 读取会话（优先内存）。不属于该用户时视为不存在。 */
  get(user: string, id: string): LoadedSession {
    const hit = this.resident.get(id);
    if (hit) {
      if (hit.s.meta.user !== user) throw new SessionNotFound(id);
      hit.touchedAt = this.now();
      return hit.s;
    }
    const row = this.db
      .prepare(`SELECT ${META_COLS}, json(doc) AS doc FROM sessions WHERE id = ? AND user = ?`)
      .get(id, user) as (Row & { doc: string }) | undefined;
    if (!row) throw new SessionNotFound(id);
    const s: LoadedSession = { meta: toMeta(row), doc: parseSessionDoc(row.doc) };
    this.keep(s);
    return s;
  }

  /** 该角色最近活跃的会话。 */
  latest(user: string, characterId: string): LoadedSession | undefined {
    const row = this.db
      .prepare('SELECT id FROM sessions WHERE user = ? AND character_id = ? ORDER BY last_active_at DESC LIMIT 1')
      .get(user, characterId) as { id: string } | undefined;
    return row && this.get(user, row.id);
  }

  list(user: string, characterId?: string): SessionMeta[] {
    const rows = (
      characterId === undefined
        ? this.db.prepare(`SELECT ${META_COLS} FROM sessions WHERE user = ? ORDER BY last_active_at DESC`).all(user)
        : this.db
            .prepare(`SELECT ${META_COLS} FROM sessions WHERE user = ? AND character_id = ? ORDER BY last_active_at DESC`)
            .all(user, characterId)
    ) as unknown as Row[];
    return rows.map(toMeta);
  }

  /** 修改会话并立即写回。fn 是同步的，所以同一会话的修改天然串行。 */
  mutate<T>(user: string, id: string, fn: (doc: SessionDoc) => T): T {
    const s = this.get(user, id);
    // 在副本上修改，fn 抛错时内存中的文档保持原样。
    const draft = structuredClone(s.doc);
    const result = fn(draft);
    const now = this.now();
    const sum = summarize(draft);
    this.db
      .prepare('UPDATE sessions SET doc = jsonb(?), last_active_at = ?, layer_count = ?, last_text = ? WHERE id = ?')
      .run(serializeSessionDoc(draft), now, sum.layerCount, sum.lastText, id);
    s.doc = draft;
    s.meta.lastActiveAt = now;
    s.meta.layerCount = sum.layerCount;
    s.meta.lastText = sum.lastText;
    this.onWritten?.(user, id, draft);
    return result;
  }

  /** 删除会话。它的分支改挂到它的父会话下面（没有父会话就成为顶层），树的形状保持。 */
  delete(user: string, id: string): void {
    const s = this.get(user, id);
    const parent = s.meta.parentId;
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE sessions SET parent_id = ? WHERE parent_id = ? AND user = ?').run(parent, id, user);
      this.db.prepare('DELETE FROM sessions WHERE id = ? AND user = ?').run(id, user);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.resident.delete(id);
    for (const r of this.resident.values()) if (r.s.meta.parentId === id) r.s.meta.parentId = parent;
    this.onWritten?.(user, id, null);
  }

  /** 移出长时间未使用的会话。 */
  sweep(): void {
    const cutoff = this.now() - this.idleMs;
    for (const [id, r] of this.resident) if (r.touchedAt < cutoff) this.resident.delete(id);
  }

  get residentCount(): number {
    return this.resident.size;
  }

  private keep(s: LoadedSession): void {
    this.resident.set(s.meta.id, { s, touchedAt: this.now() });
  }
}
