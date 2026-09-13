import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '@instead/core';
import { FakeAdapter, FakeChannel } from '@instead/core/testing';
import { IpcClient } from '../src/ipc.ts';
import { Daemon } from '../src/server.ts';

const tmpSock = () => join(mkdtempSync(join(tmpdir(), 'instead-daemon-')), 'd.sock');

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor timed out');
}

test('daemon：通过 IPC 完成绑定 → 注入入站 → 出站回复 全链路', async () => {
  const db = openDb(':memory:');
  const channel = new FakeChannel();
  const adapter = new FakeAdapter({ reply: 'pong' });
  const socketPath = tmpSock();
  const daemon = new Daemon({
    db,
    channel,
    adapters: { pi: adapter },
    socketPath,
    allowInjection: true,
    streamProgress: false,
    flushIntervalMs: 60_000,
    sweepIntervalMs: 60_000,
  });
  await daemon.start();
  const client = await IpcClient.connect(socketPath);

  await client.call('bind.add', {
    chatId: 'oc_a',
    sessionId: 'sess-1',
    agent: 'pi',
    cwd: '/repo',
    ownerOpenId: 'ou_owner',
  });
  assert.equal((await client.call<unknown[]>('bind.list')).length, 1);

  await client.call('inbound.inject', {
    message: {
      id: 'evt-1',
      channel: 'feishu',
      conversationKey: 'feishu:chat:oc_a',
      actor: { id: 'ou_owner', name: '张三' },
      text: 'hi',
      attachments: [],
      ts: Date.now(),
      mentioned: true,
    },
  });
  await waitFor(() => channel.sent.length > 0);
  assert.equal(channel.sent[0]!.text, 'pong');
  assert.equal(adapter.startCount, 1, '同一 session 只起一个进程');

  const status = await client.call<{ bindings: number; sessions: number }>('status');
  assert.equal(status.bindings, 1);
  assert.equal(status.sessions, 1);

  await assert.rejects(
    () =>
      client.call('bind.add', {
        chatId: 'oc_a',
        sessionId: 'sess-2',
        agent: 'pi',
        cwd: '/repo',
        ownerOpenId: 'ou_x',
      }),
    /已绑定/,
  );

  client.close();
  await daemon.stop();
});

test('daemon：签发一次性码（6 位数字 + TTL）', async () => {
  const db = openDb(':memory:');
  const socketPath = tmpSock();
  const daemon = new Daemon({
    db,
    channel: new FakeChannel(),
    adapters: { pi: new FakeAdapter() },
    socketPath,
    allowInjection: true,
    flushIntervalMs: 60_000,
    sweepIntervalMs: 60_000,
  });
  await daemon.start();
  const client = await IpcClient.connect(socketPath);
  const issued = await client.call<{ code: string; expiresAt: number }>('bind.code.issue', {
    sessionId: 'sess-1',
    agent: 'pi',
    cwd: '/repo',
  });
  assert.match(issued.code, /^\d{6}$/);
  assert.ok(issued.expiresAt > Date.now());
  client.close();
  await daemon.stop();
});

test('daemon：默认关闭注入（安全）', async () => {
  const socketPath = tmpSock();
  const daemon = new Daemon({
    db: openDb(':memory:'),
    channel: new FakeChannel(),
    adapters: { pi: new FakeAdapter() },
    socketPath,
    flushIntervalMs: 60_000,
    sweepIntervalMs: 60_000,
  });
  await daemon.start();
  const client = await IpcClient.connect(socketPath);
  await assert.rejects(() => client.call('inbound.inject', { message: {} }), /injection disabled/);
  client.close();
  await daemon.stop();
});
