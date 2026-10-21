import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** 按顺序执行，user_version 记录已执行到第几条。只追加，不修改已发布的迁移。 */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE sessions (
     id             TEXT PRIMARY KEY,
     user           TEXT NOT NULL,
     character_id   TEXT NOT NULL,
     created_at     INTEGER NOT NULL,
     last_active_at INTEGER NOT NULL,
     doc            BLOB NOT NULL          -- JSONB
   ) STRICT;
   CREATE INDEX sessions_by_character ON sessions (user, character_id, last_active_at DESC);`,
  `CREATE TABLE library (
     user       TEXT NOT NULL,
     kind       TEXT NOT NULL,
     id         TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     doc        BLOB NOT NULL,           -- JSONB
     PRIMARY KEY (user, kind, id)
   ) STRICT;
   CREATE TABLE settings (
     user TEXT PRIMARY KEY,
     doc  BLOB NOT NULL                  -- JSONB
   ) STRICT;
   CREATE TABLE counters (
     user  TEXT NOT NULL,
     name  TEXT NOT NULL,
     value INTEGER NOT NULL,
     PRIMARY KEY (user, name)
   ) STRICT;`,
  // 会话树：分支来源、名字，以及列表里显示用的摘要（层数、最后一条消息的开头）
  `ALTER TABLE sessions ADD COLUMN parent_id TEXT;
   ALTER TABLE sessions ADD COLUMN branch_from TEXT;
   ALTER TABLE sessions ADD COLUMN title TEXT NOT NULL DEFAULT '';
   ALTER TABLE sessions ADD COLUMN layer_count INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE sessions ADD COLUMN last_text TEXT NOT NULL DEFAULT '';
   UPDATE sessions SET layer_count = coalesce(json_array_length(json(doc), '$.layers'), 0);`,
  // 角色卡头像：原图存这里，角色卡里只记版本号
  `CREATE TABLE avatars (
     user         TEXT NOT NULL,
     character_id TEXT NOT NULL,
     mime         TEXT NOT NULL,
     data         BLOB NOT NULL,
     updated_at   INTEGER NOT NULL,
     PRIMARY KEY (user, character_id)
   ) STRICT;`,
  // 附件与引用关系（按会话）
  `CREATE TABLE attachments (
     user        TEXT NOT NULL,
     id          TEXT NOT NULL,
     name        TEXT NOT NULL,
     mime        TEXT NOT NULL,
     size        INTEGER NOT NULL,
     sha256      TEXT NOT NULL,
     data        BLOB NOT NULL,
     created_at  INTEGER NOT NULL,
     orphaned_at INTEGER,
     PRIMARY KEY (user, id)
   ) STRICT;
   CREATE INDEX attachments_by_hash ON attachments (user, sha256);
   CREATE TABLE attachment_refs (
     user          TEXT NOT NULL,
     attachment_id TEXT NOT NULL,
     session_id    TEXT NOT NULL,
     PRIMARY KEY (user, attachment_id, session_id)
   ) STRICT;
   CREATE INDEX attachment_refs_by_session ON attachment_refs (user, session_id);`,
  // 召回用的向量索引：每块一行，文字按会话文档重新切块，用 hash 判断是否变化
  `CREATE TABLE recall_chunks (
     user       TEXT NOT NULL,
     session_id TEXT NOT NULL,
     message_id TEXT NOT NULL,
     seq        INTEGER NOT NULL,
     hash       TEXT NOT NULL,
     model      TEXT NOT NULL,
     vector     BLOB NOT NULL,
     PRIMARY KEY (user, session_id, message_id, seq)
   ) STRICT;`,
];

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
