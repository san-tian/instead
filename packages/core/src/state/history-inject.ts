import type { Db } from './db.ts';

/**
 * /history 命令（决策 30）：按需注入更多群历史。
 * 一次性的：只作用于**下一条**入站消息，用完即清。
 */
export function setHistoryInject(db: Db, chatId: string, count: number, now = Date.now()): void {
  db.prepare(
    'INSERT INTO history_injects (chat_id, count, created_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(chat_id) DO UPDATE SET count = excluded.count, created_at = excluded.created_at',
  ).run(chatId, count, now);
}

/** 读取并清除待注入的条数；没有返回 undefined */
export function takeHistoryInject(db: Db, chatId: string): number | undefined {
  const row = db.prepare('SELECT count FROM history_injects WHERE chat_id = ?').get(chatId) as
    | { count: number }
    | undefined;
  if (!row) return undefined;
  db.prepare('DELETE FROM history_injects WHERE chat_id = ?').run(chatId);
  return row.count;
}
