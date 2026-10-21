// 附件：任何文件都可以上传，按原文件存进数据库（同一账号内相同内容只存一份）。
// 引用关系按会话记录：会话文档每次写回时重算它引用了哪些附件。
// 没有被任何会话引用的附件开始计时，连续 N 天（config.json 的 attachmentRetentionDays，默认 7）没被引用就清理；
// 重新被引用后计时清零。被引用的附件不能手动删除。

import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AttachmentRef } from '../../core/types.ts';

export class AttachmentError extends Error {
  readonly code: 'not-found' | 'in-use' | 'invalid';
  constructor(code: AttachmentError['code'], message: string) {
    super(message);
    this.name = 'AttachmentError';
    this.code = code;
  }
}

export interface AttachmentInfo extends AttachmentRef {
  createdAt: number;
  /** 被几个会话引用。 */
  refs: number;
  /** 开始没被引用的时间；被引用时为 null。 */
  orphanedAt: number | null;
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const newId = () => [...randomBytes(16)].map((b) => BASE62[b % 62]).join('');

export const ATTACHMENT_LIMIT = 30 * 1024 * 1024;

export class AttachmentStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  /** 保存文件；相同内容已存在时直接返回原来的（名字以第一次上传的为准）。 */
  put(user: string, name: string, mime: string, data: Uint8Array): AttachmentRef {
    if (data.length === 0) throw new AttachmentError('invalid', '文件是空的');
    if (data.length > ATTACHMENT_LIMIT) throw new AttachmentError('invalid', `文件太大（上限 ${ATTACHMENT_LIMIT / 1024 / 1024} MB）`);
    const sha = createHash('sha256').update(data).digest('hex');
    const hit = this.db.prepare('SELECT id, name, mime, size FROM attachments WHERE user = ? AND sha256 = ?').get(user, sha) as AttachmentRef | undefined;
    if (hit) return { ...hit };
    const ref: AttachmentRef = { id: newId(), name: name.slice(0, 200) || '未命名', mime: mime || 'application/octet-stream', size: data.length };
    const now = this.now();
    this.db
      .prepare('INSERT INTO attachments (user, id, name, mime, size, sha256, data, created_at, orphaned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(user, ref.id, ref.name, ref.mime, ref.size, sha, data, now, now);
    return ref;
  }

  ref(user: string, id: string): AttachmentRef | undefined {
    const r = this.db.prepare('SELECT id, name, mime, size FROM attachments WHERE user = ? AND id = ?').get(user, id) as AttachmentRef | undefined;
    return r ? { ...r } : undefined;
  }

  data(user: string, id: string): { mime: string; name: string; data: Uint8Array } | undefined {
    const r = this.db.prepare('SELECT mime, name, data FROM attachments WHERE user = ? AND id = ?').get(user, id) as
      | { mime: string; name: string; data: Uint8Array }
      | undefined;
    return r ? { ...r } : undefined;
  }

  list(user: string): AttachmentInfo[] {
    return (
      this.db
        .prepare(
          `SELECT a.id, a.name, a.mime, a.size, a.created_at AS createdAt, a.orphaned_at AS orphanedAt,
                  (SELECT count(*) FROM attachment_refs r WHERE r.user = a.user AND r.attachment_id = a.id) AS refs
             FROM attachments a WHERE a.user = ? ORDER BY a.created_at DESC`,
        )
        .all(user) as unknown as AttachmentInfo[]
    ).map((r) => ({ ...r }));
  }

  /** 会话引用的附件变了：替换这个会话的引用，并更新相关附件的计时。 */
  setSessionRefs(user: string, sessionId: string, ids: readonly string[]): void {
    const before = (this.db.prepare('SELECT attachment_id AS id FROM attachment_refs WHERE user = ? AND session_id = ?').all(user, sessionId) as { id: string }[]).map((r) => r.id);
    const next = new Set(ids);
    if (before.length === next.size && before.every((id) => next.has(id))) return;
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM attachment_refs WHERE user = ? AND session_id = ?').run(user, sessionId);
      const ins = this.db.prepare('INSERT OR IGNORE INTO attachment_refs (user, attachment_id, session_id) VALUES (?, ?, ?)');
      for (const id of next) ins.run(user, id, sessionId);
      this.refreshOrphans(user, [...new Set([...before, ...next])]);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private refreshOrphans(user: string, ids: readonly string[]): void {
    const now = this.now();
    const used = this.db.prepare('SELECT 1 FROM attachment_refs WHERE user = ? AND attachment_id = ? LIMIT 1');
    const set = this.db.prepare('UPDATE attachments SET orphaned_at = ? WHERE user = ? AND id = ?');
    const keep = this.db.prepare('UPDATE attachments SET orphaned_at = coalesce(orphaned_at, ?) WHERE user = ? AND id = ?');
    for (const id of ids) {
      if (used.get(user, id)) set.run(null, user, id);
      else keep.run(now, user, id);
    }
  }

  /** 手动删除；还被引用时不能删。 */
  delete(user: string, id: string): void {
    if (!this.ref(user, id)) throw new AttachmentError('not-found', `附件不存在：${id}`);
    const n = (this.db.prepare('SELECT count(*) AS n FROM attachment_refs WHERE user = ? AND attachment_id = ?').get(user, id) as { n: number }).n;
    if (n > 0) throw new AttachmentError('in-use', `还有 ${n} 个会话引用这个附件，不能删除`);
    this.db.prepare('DELETE FROM attachments WHERE user = ? AND id = ?').run(user, id);
  }

  /** 清理连续 retentionMs 没被引用的附件，返回清理的数量。 */
  sweep(retentionMs: number): number {
    const { changes } = this.db.prepare('DELETE FROM attachments WHERE orphaned_at IS NOT NULL AND orphaned_at < ?').run(this.now() - retentionMs);
    return Number(changes);
  }
}
