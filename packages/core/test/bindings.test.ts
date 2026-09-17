import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from './helpers.ts';
import {
  BindError,
  consumeBindCode,
  getBindCode,
  getBinding,
  updateBindingAgent,
  insertBinding,
  issueBindCode,
  listBindingsBySession,
  pruneExpiredBindCodes,
} from '../src/state/bindings.ts';

const binding = (chatId: string, sessionId = 'sess-1') => ({
  chatId,
  sessionId,
  agent: 'pi' as const,
  cwd: '/repo',
  ownerOpenId: 'ou_owner',
  mirrorMode: 'off' as const,
  createdAt: 1000,
});

test('同一 chat 重复绑定 → 主键冲突（§1.1 机制保证）', () => {
  const db = memoryDb();
  insertBinding(db, binding('oc_a'));
  assert.throws(
    () => insertBinding(db, binding('oc_a', 'sess-2')),
    (err: unknown) => err instanceof BindError && err.code === 'chat_already_bound',
  );
  // 原绑定未被覆盖
  assert.equal(getBinding(db, 'oc_a')?.sessionId, 'sess-1');
});

test('session 1:N chat —— 一条 session 可绑多个群', () => {
  const db = memoryDb();
  insertBinding(db, binding('oc_a', 'sess-1'));
  insertBinding(db, binding('oc_b', 'sess-1'));
  insertBinding(db, binding('oc_c', 'sess-2'));
  assert.deepEqual(
    listBindingsBySession(db, 'sess-1').map((b) => b.chatId),
    ['oc_a', 'oc_b'],
  );
});

test('一次性码：消费后建绑 + 码立即失效', () => {
  const db = memoryDb();
  issueBindCode(db, { code: '482193', sessionId: 'sess-1', agent: 'pi', cwd: '/repo', now: 1000 });
  const created = consumeBindCode(db, {
    code: '482193',
    chatId: 'oc_a',
    ownerOpenId: 'ou_owner',
    now: 2000,
  });
  assert.equal(created.sessionId, 'sess-1');
  assert.equal(created.ownerOpenId, 'ou_owner');
  assert.equal(getBindCode(db, '482193'), undefined, '码应被删除');
  assert.throws(
    () => consumeBindCode(db, { code: '482193', chatId: 'oc_b', ownerOpenId: 'ou_x', now: 3000 }),
    (err: unknown) => err instanceof BindError && err.code === 'code_not_found',
  );
});

test('过期码被拒绝并清理', () => {
  const db = memoryDb();
  issueBindCode(db, {
    code: '111111',
    sessionId: 'sess-1',
    agent: 'pi',
    cwd: '/repo',
    now: 1000,
    ttlMs: 1000,
  });
  assert.throws(
    () => consumeBindCode(db, { code: '111111', chatId: 'oc_a', ownerOpenId: 'ou_o', now: 3000 }),
    (err: unknown) => err instanceof BindError && err.code === 'code_expired',
  );
  // 惰性清理：不在事务里删，靠 pruneExpiredBindCodes
  assert.ok(getBindCode(db, '111111'));
  assert.equal(pruneExpiredBindCodes(db, 3000), 1);
  assert.equal(getBindCode(db, '111111'), undefined);
});

test('判定顺序：先查占用再查凭据 —— 已绑群即使码有效也拒绝', () => {
  const db = memoryDb();
  insertBinding(db, binding('oc_a', 'sess-existing'));
  issueBindCode(db, { code: '222222', sessionId: 'sess-2', agent: 'pi', cwd: '/repo', now: 1000 });
  assert.throws(
    () => consumeBindCode(db, { code: '222222', chatId: 'oc_a', ownerOpenId: 'ou_o', now: 2000 }),
    (err: unknown) => err instanceof BindError && err.code === 'chat_already_bound',
  );
  // 码未被消费，可继续用于别的群
  assert.ok(getBindCode(db, '222222'));
});

test('同一 session 重签覆盖旧码', () => {
  const db = memoryDb();
  issueBindCode(db, { code: '111111', sessionId: 'sess-1', agent: 'pi', cwd: '/repo', now: 1000 });
  issueBindCode(db, { code: '999999', sessionId: 'sess-1', agent: 'pi', cwd: '/repo', now: 2000 });
  assert.equal(getBindCode(db, '111111'), undefined);
  assert.ok(getBindCode(db, '999999'));
});

test('updateBindingAgent：只改 agent 和会话 id，其余字段不动（决策 31）', () => {
  const db = memoryDb();
  insertBinding(db, {
    chatId: 'oc_a', sessionId: 'sess-old', agent: 'pi', cwd: '/repo',
    ownerOpenId: 'ou_owner', mirrorMode: 'user', createdAt: 1,
  });
  const updated = updateBindingAgent(db, 'oc_a', 'codex', 'is-new1');
  assert.equal(updated?.agent, 'codex');
  assert.equal(updated?.sessionId, 'is-new1');
  assert.equal(updated?.cwd, '/repo', '目录不动');
  assert.equal(updated?.ownerOpenId, 'ou_owner', 'owner 不动');
  assert.equal(updated?.mirrorMode, 'user', 'mirror 不动');
  assert.equal(getBinding(db, 'oc_a')?.agent, 'codex', '落盘');
  assert.equal(updateBindingAgent(db, 'oc_x', 'pi', 'x'), undefined, '没绑定的群返回 undefined');
});
