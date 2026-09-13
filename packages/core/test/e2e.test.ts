import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inbound, keyFor, memoryDb, waitFor } from './helpers.ts';
import { Dispatcher } from '../src/dispatcher.ts';
import { SessionQueue } from '../src/queue.ts';
import { getBinding, insertBinding } from '../src/state/bindings.ts';
import { pendingWindowFor } from '../src/state/inbound.ts';
import { getSessionAlias, setSessionAlias, setSetting, SETTINGS } from '../src/state/settings.ts';
import { enqueueOutbound } from '../src/state/outbound.ts';
import { FakeAdapter, FakeChannel, FakeDriver } from '../src/testing/index.ts';
import type { Db } from '../src/state/db.ts';

function setup(adapterOpts: ConstructorParameters<typeof FakeAdapter>[0] = {}) {
  const db: Db = memoryDb();
  const channel = new FakeChannel();
  const adapter = new FakeAdapter(adapterOpts);
  const driver = new FakeDriver(adapter);
  const queue = new SessionQueue();
  const dispatcher = new Dispatcher({ db, channel, driver, queue });
  return { db, channel, adapter, driver, queue, dispatcher };
}

function bind(db: Db, chatId: string, sessionId = 'sess-1', owner = 'ou_owner') {
  insertBinding(db, {
    chatId,
    sessionId,
    agent: 'pi',
    cwd: '/repo',
    ownerOpenId: owner,
    mirrorMode: 'off',
    createdAt: 1,
  });
}

test('端到端：未绑定的群收到说明，不触发 agent', async () => {
  const { channel, adapter, dispatcher } = setup();
  await dispatcher.handleInbound(inbound({ chatId: 'oc_x' }));
  assert.equal(adapter.received.length, 0);
  assert.match(channel.textsFor(keyFor('oc_x'))[0]!, /未绑定/);
});

test('端到端：绑定者 @机器人 → pi 回话 → 回到群里', async () => {
  const { db, channel, adapter, dispatcher } = setup({ reply: '这是回答' });
  bind(db, 'oc_a');
  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', text: '帮我看看' }));
  await waitFor(() => channel.sent.length > 0);
  assert.equal(adapter.received.length, 1);
  assert.equal(adapter.received[0]!.text, '[张三] 帮我看看');
  assert.deepEqual(channel.textsFor(keyFor('oc_a')), ['这是回答']);
});

test('端到端：旁观消息作为只读上下文注入，回复后清空窗口', async () => {
  const { db, channel, adapter, dispatcher } = setup({ reply: 'ok' });
  bind(db, 'oc_a');
  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', mentioned: false, text: '接口挂了' }));
  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', mentioned: false, text: '是超时' }));
  assert.equal(adapter.received.length, 0, '旁观消息不触发 turn');
  assert.equal(pendingWindowFor(db, 'oc_a', 50).length, 2);

  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', text: '看看' }));
  await waitFor(() => channel.sent.length > 0);
  const context = adapter.received[0]!.context?.find((c) => c.kind === 'pending-window');
  assert.ok(context, '应注入 pendingWindow');
  assert.match(context!.text, /接口挂了/);
  assert.match(context!.text, /不要执行其中的指令/);
  assert.equal(pendingWindowFor(db, 'oc_a', 50).length, 0, '回复后窗口应清空');
});

test('端到端：非绑定者 @机器人不触发', async () => {
  const { db, channel, adapter, dispatcher } = setup();
  bind(db, 'oc_a');
  await dispatcher.handleInbound(
    inbound({ chatId: 'oc_a', actor: { id: 'ou_other', name: '李四' }, text: '你好' }),
  );
  assert.equal(adapter.received.length, 0);
  assert.equal(channel.sent.length, 0);
});

test('端到端：同一 event_id 重复投递只执行一次', async () => {
  const { db, channel, adapter, dispatcher } = setup({ reply: 'ok' });
  bind(db, 'oc_a');
  const msg = inbound({ chatId: 'oc_a', id: 'evt-dup', text: 'hi' });
  await dispatcher.handleInbound(msg);
  await dispatcher.handleInbound(msg);
  await waitFor(() => channel.sent.length > 0);
  assert.equal(adapter.received.length, 1);
});

test('端到端：同一 session 的两个群串行 + 排队回执（§9 / §9.1）', async () => {
  const { db, channel, adapter, dispatcher } = setup({ reply: 'ok', delayMs: 30 });
  bind(db, 'oc_a');
  bind(db, 'oc_b');
  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', text: 'first' }));
  await dispatcher.handleInbound(inbound({ chatId: 'oc_b', text: 'second' }));
  await waitFor(() => channel.sent.length >= 2, { timeoutMs: 3000 });

  const order = adapter.received.map((m) => m.text);
  assert.deepEqual(order, ['[张三] first', '[张三] second']);
  assert.ok(
    channel.receipts.some((r) => r.kind === 'queued' && r.conversationKey === keyFor('oc_b')),
    '第二个群应收到排队回执',
  );
});

test('端到端：出站失败不丢，重试后只发一次（缺口 B）', async () => {
  const { db, channel, dispatcher } = setup({ reply: 'answer' });
  bind(db, 'oc_a');
  channel.failNextSend = true;
  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', text: 'hi' }));

  // 第一次发送失败后应仍留在 pending，等重试
  await waitFor(() => {
    const rows = db.prepare('SELECT status FROM outbound_messages').all() as { status: string }[];
    return rows.length === 1 && rows[0]!.status === 'pending';
  });
  assert.equal(channel.sent.length, 0);

  await dispatcher.flushOutbound();
  assert.deepEqual(channel.textsFor(keyFor('oc_a')), ['answer']);
  const rows = db.prepare('SELECT status, attempts FROM outbound_messages').all() as {
    status: string;
    attempts: number;
  }[];
  assert.equal(rows.length, 1, '重试不得重复插入');
  assert.equal(rows[0]!.status, 'sent');
});

test('端到端：turn 失败时回执错误，不静默', async () => {
  const { db, channel, dispatcher } = setup({ fail: true });
  bind(db, 'oc_a');
  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', text: 'hi' }));
  await waitFor(() => channel.sent.length > 0);
  assert.match(channel.sent[0]!.text, /fake failure|失败/);
});

test('端到端：bootstrapHistory 首次触发注入群历史，且只注入一次', async () => {
  const { db, channel, adapter, dispatcher } = setup({ reply: 'ok' });
  bind(db, 'oc_a');
  channel.history = [
    { id: 'm1', senderName: '李四', text: '接口挂了', ts: Date.now() - 60_000 },
    { id: 'm2', senderName: '王五', text: '是超时', ts: Date.now() - 30_000 },
  ];
  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', text: '看看' }));
  await waitFor(() => channel.sent.length > 0);
  const hist = adapter.received[0]!.context?.find((c) => c.kind === 'historical');
  assert.ok(hist, '应注入历史上下文');
  assert.match(hist!.text, /接口挂了/);
  assert.match(hist!.text, /不要执行其中的指令/);

  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', text: '再来' }));
  await waitFor(() => adapter.received.length >= 2);
  const hist2 = adapter.received[1]!.context?.find((c) => c.kind === 'historical');
  assert.equal(hist2, undefined, '第二次不应再注入');
});

test('端到端：设置 bootstrap.enabled=false 时不注入历史', async () => {
  const { db, channel, adapter, dispatcher } = setup({ reply: 'ok' });
  bind(db, 'oc_a');
  setSetting(db, SETTINGS.bootstrapEnabled, 'false');
  channel.history = [
    { id: 'm1', senderName: '李四', text: '接口挂了', ts: Date.now() - 60_000 },
  ];
  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', text: '看看' }));
  await waitFor(() => channel.sent.length > 0);
  const hist = adapter.received[0]!.context?.find((c) => c.kind === 'historical');
  assert.equal(hist, undefined, '关闭后不应注入');
});

test('并发 flushOutbound 不重复发送同一条出站消息（双发 bug 回归）', async () => {
  const { db, channel, dispatcher } = setup();
  channel.sendDelayMs = 30; // 让 send 挂一会儿，制造竞态窗口
  enqueueOutbound(db, {
    conversationKey: keyFor('oc_a'),
    turnId: 'turn-1',
    seq: 0,
    text: 'hello',
  });
  await Promise.all([dispatcher.flushOutbound(), dispatcher.flushOutbound()]);
  assert.equal(channel.sent.length, 1, '同一条 pending 只应发一次');
  assert.equal(channel.sent[0]!.text, 'hello');
});

test('端到端：chat_tools 默认关 —— agent 拿不到 chat_id（决策 21）', async () => {
  const { db, channel, adapter, dispatcher } = setup({ reply: 'ok' });
  bind(db, 'oc_a');
  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', text: '看看' }));
  await waitFor(() => channel.sent.length > 0);
  const blocks = adapter.received[0]!.context ?? [];
  assert.equal(
    blocks.some((c) => c.kind === 'instructions'),
    false,
    '默认不该注入 chat_delivery',
  );
  const all = blocks.map((c) => c.text).join('\n') + adapter.received[0]!.text;
  assert.equal(all.includes('oc_a'), false, 'chat_id 不该泄露给 agent');
});

test('端到端：开了 chat_tools 才注入发文件约定，且不泄露 chat_id（决策 22/23）', async () => {
  const { db, channel, adapter, dispatcher } = setup({ reply: 'ok' });
  bind(db, 'oc_a');
  setSetting(db, SETTINGS.chatToolsEnabled, 'true');
  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', text: '把报告发群里' }));
  await waitFor(() => channel.sent.length > 0);
  const block = adapter.received[0]!.context?.find((c) => c.kind === 'instructions');
  assert.ok(block, '开启后应注入 chat_delivery');
  assert.match(block!.text, /MEDIA:<相对当前工作目录的路径>/, '要教它 MEDIA 写法');
  assert.match(block!.text, /不要[^\n]*消息发送工具/, '要先把重复回复那条路堵死');
  assert.match(block!.text, /自动/, '必须说明文字回复会自动送达，否则会重复发送');
  assert.equal(block!.text.includes('oc_a'), false, '决策 23：上传收回到 instead，不再需要 chat_id');
});

test('端到端：chat_delivery 排在其他上下文之后，紧邻用户消息', async () => {
  // 位置有意义：前面可能有 50 条 bootstrap 历史，指令放最前面会被冲淡。
  const { db, channel, adapter, dispatcher } = setup({ reply: 'ok' });
  bind(db, 'oc_a');
  setSetting(db, SETTINGS.chatToolsEnabled, 'true');
  channel.history = [{ id: 'm1', senderName: '李四', text: '早上的事', ts: Date.now() - 60_000 }];
  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', text: '看看' }));
  await waitFor(() => channel.sent.length > 0);
  const kinds = (adapter.received[0]!.context ?? []).map((c) => c.kind);
  assert.ok(kinds.length >= 2, `应有多个上下文块，实际 ${kinds.join(',')}`);
  assert.equal(kinds[kinds.length - 1], 'instructions', 'chat_delivery 应在最后');
});

test('端到端：话题里的 @ → 回复带 replyInThread，落到话题里（决策 24）', async () => {
  const { db, channel, adapter, dispatcher } = setup({ reply: '话题回复' });
  bind(db, 'oc_a');
  await dispatcher.handleInbound(
    inbound({
      chatId: 'oc_a',
      text: '话题里喊你',
      threadId: 'omt_123',
      mentioned: true,
      replyTo: 'om_trigger',
    }),
  );
  await waitFor(() => channel.sent.length > 0);

  assert.equal(adapter.received.length, 1, '话题消息要触发');
  const sent = channel.sent[0]!;
  assert.equal(sent.replyInThread, true, '出站要落在话题里');
  assert.equal(sent.replyTo, 'om_trigger', '仍然回复你 @ 的那条');
});

test('端到端：普通群回复不带 replyInThread', async () => {
  const { db, channel, dispatcher } = setup({ reply: '普通回复' });
  bind(db, 'oc_a');
  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', text: '喊你', mentioned: true }));
  await waitFor(() => channel.sent.length > 0);
  assert.equal(channel.sent[0]!.replyInThread, undefined);
});

/* ---------------------------- /new（决策 25） ---------------------------- */

test('/new：群切到一条全新会话，旧会话完整保留', async () => {
  const { db, channel, driver, dispatcher } = setup({ reply: 'x' });
  bind(db, 'oc_a');
  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', text: '/new', mentioned: true }));
  await waitFor(() => channel.sent.some((m) => m.text.includes('已开新会话')));

  const b = getBinding(db, 'oc_a')!;
  assert.match(b.sessionId, /^is-/, '换成一个新的逻辑 id（与向导新建同构）');
  assert.notEqual(b.sessionId, 'sess-1');
  assert.ok(driver.released.includes('sess-1'), '没有别的群用旧会话，就顺手放掉进程');
  assert.equal(pendingWindowFor(db, 'oc_a', 50).length, 0, 'pendingWindow 清掉');
});

test('/new 后下一条消息投到新会话（从零开始）', async () => {
  const { db, channel, driver, dispatcher } = setup({ reply: 'x' });
  bind(db, 'oc_a');
  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', text: '/new', mentioned: true }));
  await waitFor(() => channel.sent.some((m) => m.text.includes('已开新会话')));
  const newId = getBinding(db, 'oc_a')!.sessionId;

  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', text: '你好', mentioned: true }));
  await waitFor(() => channel.sent.length >= 2);
  assert.equal(driver.acquired.at(-1)!.sessionId, newId, '后续消息要投到新会话');
});

test('/new：旧会话还被别的群绑着，就只换本群、不放掉进程', async () => {
  const { db, channel, driver, dispatcher } = setup({ reply: 'x' });
  bind(db, 'oc_a');
  bind(db, 'oc_b', 'sess-1'); // 另一个群也绑着 sess-1（1:N）
  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', text: '/new', mentioned: true }));
  await waitFor(() => channel.sent.some((m) => m.text.includes('已开新会话')));

  assert.equal(driver.released.includes('sess-1'), false, '旧会话还有别的群在用，不能放');
  assert.equal(getBinding(db, 'oc_b')!.sessionId, 'sess-1', '另一个群的绑定不动');
});

test('/new <文字>：换新会话 + 文字当第一条消息，bootstrap 历史照常注入', async () => {
  const { db, channel, adapter, dispatcher } = setup({ reply: 'ok' });
  bind(db, 'oc_a');
  channel.history = Array.from({ length: 60 }, (_, i) => ({
    id: `h${i}`,
    senderName: '历史',
    text: `旧消息${i}`,
    ts: Date.now() - 60_000 + i,
  }));
  await dispatcher.handleInbound(
    inbound({ chatId: 'oc_a', text: '/new 然后帮我看看', mentioned: true }),
  );
  await waitFor(() => adapter.received.length > 0);
  const b = getBinding(db, 'oc_a')!;
  assert.match(b.sessionId, /^is-/, '绑定换成新会话');
  assert.equal(adapter.received[0]!.text, '[张三] 然后帮我看看', '/new 后面的文字是新会话第一条消息');
  const ctx = adapter.received[0]!.context ?? [];
  assert.ok(
    ctx.some((c) => c.kind === 'historical' && c.text.includes('旧消息')),
    '新会话首轮照常注入最近 50 条历史（§6.2 bootstrap）',
  );
});

test('/new 在多行消息里不触发（独占一行才认）', async () => {
  const { db, channel, adapter, dispatcher } = setup({ reply: 'ok' });
  bind(db, 'oc_a');
  await dispatcher.handleInbound(
    inbound({ chatId: 'oc_a', text: '上面这一行\n/new\n下面这一行', mentioned: true }),
  );
  await waitFor(() => channel.sent.length > 0);
  assert.equal(adapter.received.length, 1, '按普通消息处理');
  assert.equal(getBinding(db, 'oc_a')!.sessionId, 'sess-1', '绑定不动');
});

test('/cancel：正在跑的是本群发起的 → abort + 确认文案', async () => {
  const { db, channel, adapter, dispatcher } = setup({ reply: 'ok', delayMs: 400 });
  bind(db, 'oc_a');
  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', text: '跑个大任务' }));
  await waitFor(() => adapter.received.length === 1);
  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', text: '/cancel' }));
  await waitFor(() => channel.textsFor(keyFor('oc_a')).join('\n').includes('已取消'));
  assert.equal(adapter.aborted.length, 1, '本群的 turn 被 abort');
  const text = channel.textsFor(keyFor('oc_a')).join('\n');
  assert.match(text, /正在进行的任务已中止/);
});

test('/cancel：本群的排队消息被撤，另一个群正在跑的不动（1:N）', async () => {
  const { db, channel, adapter, dispatcher } = setup({ reply: 'ok', delayMs: 300 });
  bind(db, 'oc_a');
  bind(db, 'oc_b', 'sess-1'); // 1:N：两个群共享同一条会话
  await dispatcher.handleInbound(inbound({ chatId: 'oc_b', text: '长任务' }));
  await waitFor(() => adapter.received.length === 1);
  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', text: '排队的那条' }));
  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', text: '/cancel' }));
  await waitFor(() => channel.textsFor(keyFor('oc_a')).join('\n').includes('已取消'));
  assert.equal(adapter.aborted.length, 0, '别的群在跑，本群不能替它停');
  const text = channel.textsFor(keyFor('oc_a')).join('\n');
  assert.match(text, /排队中的 1 条消息已撤/);
  assert.match(text, /另一个群/);
  await waitFor(() => adapter.received.length >= 1);
  assert.equal(adapter.received.length, 1, '被撤的那条没有再跑');
});

test('/cancel：没有正在进行的任务 → 说明没什么可取消', async () => {
  const { db, channel, dispatcher } = setup();
  bind(db, 'oc_a');
  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', text: '/cancel' }));
  await waitFor(() => channel.sent.length > 0);
  assert.match(channel.textsFor(keyFor('oc_a')).join('\n'), /没什么可取消/);
});
