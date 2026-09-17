import type { AgentId, BindCode, Binding, MirrorMode } from '../types.ts';
import { asRow, asRows, type Db } from './db.ts';

export type BindErrorCode =
  | 'chat_already_bound'
  | 'code_not_found'
  | 'code_expired';

export class BindError extends Error {
  readonly code: BindErrorCode;
  readonly detail?: { ownerOpenId?: string; sessionId?: string };

  constructor(
    code: BindErrorCode,
    message: string,
    detail?: { ownerOpenId?: string; sessionId?: string },
  ) {
    super(message);
    this.name = 'BindError';
    this.code = code;
    this.detail = detail;
  }
}

/** 唯一定义处 —— CLI / daemon / UI 都从这里取，不要各自再抄一份 */
export const MIRROR_MODES: readonly MirrorMode[] = ['off', 'user', 'user+assistant', 'full'];
export const isMirrorMode = (v: string): v is MirrorMode => MIRROR_MODES.includes(v as MirrorMode);

interface BindingRow {
  chat_id: string;
  session_id: string;
  agent: string;
  cwd: string;
  owner_open_id: string;
  mirror_mode: string;
  created_at: number;
}

const toBinding = (r: BindingRow): Binding => ({
  chatId: r.chat_id,
  sessionId: r.session_id,
  agent: r.agent as AgentId,
  cwd: r.cwd,
  ownerOpenId: r.owner_open_id,
  mirrorMode: r.mirror_mode as MirrorMode,
  createdAt: r.created_at,
});

export function getBinding(db: Db, chatId: string): Binding | undefined {
  const row = asRow<BindingRow>(
    db.prepare('SELECT * FROM bindings WHERE chat_id = ?').get(chatId),
  );
  return row ? toBinding(row) : undefined;
}

export function listBindings(db: Db): Binding[] {
  return asRows<BindingRow>(
    db.prepare('SELECT * FROM bindings ORDER BY created_at').all(),
  ).map(toBinding);
}

export function listBindingsBySession(db: Db, sessionId: string): Binding[] {
  return asRows<BindingRow>(
    db.prepare('SELECT * FROM bindings WHERE session_id = ? ORDER BY created_at').all(sessionId),
  ).map(toBinding);
}

/**
 * /new（决策 25）：把一个群切到另一条会话。agent / cwd / owner 都不动，只换 session_id。
 * @returns 是否真的改到了（false = 这个群没绑定）
 */
export function updateBindingSession(
  db: Db,
  chatId: string,
  sessionId: string,
  now = Date.now(),
): boolean {
  return (
    Number(
      db.prepare('UPDATE bindings SET session_id = ?, created_at = ? WHERE chat_id = ?').run(
        sessionId,
        now,
        chatId,
      ).changes,
    ) > 0
  );
}

/**
 * 写绑定。`chat_id` 是主键 —— 冲突靠数据库保证，不靠应用层检查（§1.1）。
 * @throws BindError('chat_already_bound')
 */
/**
 * 换 agent（决策 31）：只改这条绑定的 agent 与会话 id，其余字段不动。
 * 会话不能跨 agent 搬 —— 调用方应传新 agent 下的会话 id（空 = 新建由调用方生成）。
 */
export function updateBindingAgent(
  db: Db,
  chatId: string,
  agent: AgentId,
  sessionId: string,
): Binding | undefined {
  const existing = getBinding(db, chatId);
  if (!existing) return undefined;
  const res = db
    .prepare('UPDATE bindings SET agent = ?, session_id = ? WHERE chat_id = ?')
    .run(agent, sessionId, chatId);
  return res.changes > 0 ? { ...existing, agent, sessionId } : undefined;
}

export function insertBinding(db: Db, b: Binding): Binding {
  const existing = getBinding(db, b.chatId);
  if (existing) {
    throw new BindError(
      'chat_already_bound',
      `chat ${b.chatId} 已绑定 session ${existing.sessionId}`,
      { ownerOpenId: existing.ownerOpenId, sessionId: existing.sessionId },
    );
  }
  try {
    db.prepare(
      `INSERT INTO bindings (chat_id, session_id, agent, cwd, owner_open_id, mirror_mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      b.chatId,
      b.sessionId,
      b.agent,
      b.cwd,
      b.ownerOpenId,
      b.mirrorMode,
      b.createdAt,
    );
  } catch (err) {
    // 并发插入时唯一键仍会抛错，转成同一种语义
    if (String(err).includes('UNIQUE') || String(err).includes('PRIMARY KEY')) {
      const now = getBinding(db, b.chatId);
      throw new BindError('chat_already_bound', `chat ${b.chatId} 已被绑定`, {
        ownerOpenId: now?.ownerOpenId,
        sessionId: now?.sessionId,
      });
    }
    throw err;
  }
  return getBinding(db, b.chatId)!;
}

export function deleteBinding(db: Db, chatId: string): boolean {
  const res = db.prepare('DELETE FROM bindings WHERE chat_id = ?').run(chatId);
  return Number(res.changes) > 0;
}

export function setMirrorMode(db: Db, chatId: string, mode: MirrorMode): boolean {
  const res = db
    .prepare('UPDATE bindings SET mirror_mode = ? WHERE chat_id = ?')
    .run(mode, chatId);
  return Number(res.changes) > 0;
}

/* ------------------------------- 一次性绑定码 ------------------------------ */

interface BindCodeRow {
  code: string;
  session_id: string;
  agent: string;
  cwd: string;
  created_at: number;
  expires_at: number;
}

const toBindCode = (r: BindCodeRow): BindCode => ({
  code: r.code,
  sessionId: r.session_id,
  agent: r.agent as AgentId,
  cwd: r.cwd,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
});

export const DEFAULT_CODE_TTL_MS = 5 * 60 * 1000;

/** 签发码：同一 session 重签覆盖旧码（§1.2） */
export function issueBindCode(
  db: Db,
  input: { code: string; sessionId: string; agent: AgentId; cwd: string; now?: number; ttlMs?: number },
): BindCode {
  const now = input.now ?? Date.now();
  const expiresAt = now + (input.ttlMs ?? DEFAULT_CODE_TTL_MS);
  db.prepare(
    `INSERT INTO bind_codes (code, session_id, agent, cwd, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       code = excluded.code, agent = excluded.agent, cwd = excluded.cwd,
       created_at = excluded.created_at, expires_at = excluded.expires_at`,
  ).run(input.code, input.sessionId, input.agent, input.cwd, now, expiresAt);
  return { code: input.code, sessionId: input.sessionId, agent: input.agent, cwd: input.cwd, createdAt: now, expiresAt };
}

export function getBindCode(db: Db, code: string): BindCode | undefined {
  const row = asRow<BindCodeRow>(db.prepare('SELECT * FROM bind_codes WHERE code = ?').get(code));
  return row ? toBindCode(row) : undefined;
}

export function deleteBindCode(db: Db, code: string): boolean {
  return Number(db.prepare('DELETE FROM bind_codes WHERE code = ?').run(code).changes) > 0;
}

/** 配置台展示用：列出未过期的绑定码 */
export function listBindCodes(db: Db, now = Date.now()): BindCode[] {
  return asRows<BindCodeRow>(
    db.prepare('SELECT * FROM bind_codes WHERE expires_at > ? ORDER BY created_at DESC').all(now),
  ).map(toBindCode);
}

export function pruneExpiredBindCodes(db: Db, now = Date.now()): number {
  return Number(db.prepare('DELETE FROM bind_codes WHERE expires_at <= ?').run(now).changes);
}

/**
 * 群侧 `/bind <code>`：判定顺序「先查占用再查凭据」，消费码与建绑同一事务（§10.2）。
 * @throws BindError
 */
export function consumeBindCode(
  db: Db,
  input: { code: string; chatId: string; ownerOpenId: string; now?: number },
): Binding {
  const now = input.now ?? Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    const occupied = getBinding(db, input.chatId);
    if (occupied) {
      throw new BindError('chat_already_bound', '本群已绑定其他会话', {
        ownerOpenId: occupied.ownerOpenId,
        sessionId: occupied.sessionId,
      });
    }
    const found = getBindCode(db, input.code);
    if (!found) throw new BindError('code_not_found', '绑定码不存在');
    if (found.expiresAt <= now) {
      // 不在事务里删：过期码由 pruneExpiredBindCodes 惰性清理（§10.2）
      throw new BindError('code_expired', '绑定码已过期');
    }
    db.prepare(
      `INSERT INTO bindings (chat_id, session_id, agent, cwd, owner_open_id, mirror_mode, created_at)
       VALUES (?, ?, ?, ?, ?, 'off', ?)`,
    ).run(input.chatId, found.sessionId, found.agent, found.cwd, input.ownerOpenId, now);
    db.prepare('DELETE FROM bind_codes WHERE code = ?').run(input.code);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return getBinding(db, input.chatId)!;
}
