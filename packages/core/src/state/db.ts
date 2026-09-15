import { DatabaseSync } from 'node:sqlite';
import { ensureHome, paths } from '../paths.ts';

/**
 * 唯一直接触碰 node:sqlite 的模块（PLAN §2.3）。
 * 换 better-sqlite3 时只改这里。
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bindings (
  chat_id       TEXT PRIMARY KEY,          -- chat 1:1 session 的机制保证（§1.1）
  session_id    TEXT NOT NULL,
  agent         TEXT NOT NULL,
  cwd           TEXT NOT NULL,
  owner_open_id TEXT NOT NULL,
  mirror_mode   TEXT NOT NULL DEFAULT 'off',
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bindings_session ON bindings(session_id);

CREATE TABLE IF NOT EXISTS bind_codes (
  code       TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,         -- 单条 session 同时只有一个有效码（§1.2）
  agent      TEXT NOT NULL,
  cwd        TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inbound_events (
  event_id    TEXT PRIMARY KEY,            -- 渠道事件 id，去重键
  chat_id     TEXT NOT NULL,
  session_id  TEXT,
  mentioned   INTEGER NOT NULL,
  actor_id    TEXT NOT NULL,
  actor_name  TEXT,
  text        TEXT NOT NULL,
  payload     TEXT NOT NULL,               -- 完整 InboundMessage JSON
  received_at INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending|dispatched|done|dropped
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_inbound_pending ON inbound_events(status, chat_id, received_at);

CREATE TABLE IF NOT EXISTS outbound_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id    TEXT NOT NULL,
  seq        INTEGER NOT NULL DEFAULT 0,
  chat_id    TEXT NOT NULL,
  text       TEXT NOT NULL,
  reply_to   TEXT,
  status     TEXT NOT NULL DEFAULT 'pending',   -- pending|sent|failed
  attempts   INTEGER NOT NULL DEFAULT 0,
  sent_msg_id TEXT,
  created_at INTEGER NOT NULL,
  media      TEXT,                         -- 附件（决策 23）：Attachment[] 的 JSON，文本消息为 NULL
  reply_in_thread INTEGER NOT NULL DEFAULT 0,  -- 回复落在话题里（决策 24）
  UNIQUE(turn_id, seq)                     -- 出站幂等（缺口 B）
);
CREATE INDEX IF NOT EXISTS idx_outbound_pending ON outbound_messages(status, created_at);

CREATE TABLE IF NOT EXISTS session_settings (
  session_id TEXT PRIMARY KEY,
  model      TEXT,                          -- <provider>/<modelId>，为空表示用 agent 自己的默认值
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,              -- 目前用 'default_model:<agent>'
  value      TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_aliases (
  logical_id TEXT PRIMARY KEY,              -- 绑定里存的 id（稳定）
  agent      TEXT NOT NULL,
  real_id    TEXT NOT NULL,                 -- adapter/CLI 实际使用的 id（如 codex thread_id）
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS history_injects (
  chat_id    TEXT PRIMARY KEY,             -- /history 命令（决策 30）：按需补历史，一次性
  count      INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bootstrap_records (
  session_id  TEXT NOT NULL,                -- bootstrapHistory（§6.2），每个群只回填一次
  chat_id     TEXT NOT NULL,
  last_msg_id TEXT,
  count       INTEGER NOT NULL,
  text        TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL,
  PRIMARY KEY(session_id, chat_id)
);
`;

export type Db = DatabaseSync;

export function openDb(file: string = paths.stateDb()): Db {
  if (file !== ':memory:') ensureHome();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/**
 * 幂等补列。SQLite 的 `ALTER TABLE ADD COLUMN` 重复执行会报错，这里靠 try/catch
 * 吞掉「已存在」——新建库由 SCHEMA 直接带上，老库走这里补（§11：不做版本号迁移框架，
 * 只有这种加列的小改动时才不需要）。
 */
function ensureColumn(db: Db, table: string, ddl: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  } catch {
    /* 已经有了 */
  }
}

function migrate(db: Db): void {
  ensureColumn(db, 'outbound_messages', 'media TEXT');
  ensureColumn(db, 'outbound_messages', 'reply_in_thread INTEGER NOT NULL DEFAULT 0');
}

export function closeDb(db: Db): void {
  db.close();
}

/** node:sqlite 返回 Record<string, SQLOutputValue>，统一在这里收口 */
export const asRows = <T>(rows: unknown): T[] => rows as T[];
export const asRow = <T>(row: unknown): T | undefined => row as T | undefined;
