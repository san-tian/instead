import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiAdapter } from '../src/adapter.ts';
import { buildPrompt } from '../src/adapter.ts';

const withSessionDir = () => mkdtempSync(join(tmpdir(), 'instead-pi-'));
const __dirname = dirname(fileURLToPath(import.meta.url));

/** 契约测试需要真实的 pi CLI；没有就跳过（CI 友好） */
const hasPi = ((): boolean => {
  try {
    execFileSync('pi', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('buildPrompt 把上下文放在真实消息之前', () => {
  const text = buildPrompt({
    text: '[张三 · 飞书] 看看',
    context: [
      { kind: 'pending-window', conversationKey: 'feishu:chat:oc_a', text: '<pending>旧消息</pending>' },
    ],
  });
  assert.match(text, /^<pending>旧消息<\/pending>\n\n\[张三 · 飞书\] 看看$/);
});

test('契约：起真实 pi 进程，发一条消息拿到最终文本', { skip: !hasPi, timeout: 120_000 }, async () => {
  const adapter = new PiAdapter({ sessionDir: withSessionDir(), isolateExtensions: true });
  const handle = await adapter.start({ cwd: process.cwd(), sessionId: 'contract-001' });
  assert.equal(handle.ref.agent, 'pi');
  assert.equal(handle.ref.sessionId, 'contract-001');

  const turn = await adapter.send(handle, { text: 'Reply with exactly: OK' });
  const deltas: string[] = [];
  turn.onEvent((e) => {
    if (e.type === 'delta' && e.text) deltas.push(e.text);
  });
  const result = await turn.settled;
  assert.equal(result.aborted, false);
  assert.equal(result.error, undefined);
  assert.match(result.text, /OK/);
  assert.ok(deltas.join('').includes('OK'), '应收到流式 delta');

  await adapter.stop(handle);
});

test('契约：session 可续跑（同一 sessionId 再次 start 能看到历史）', { skip: !hasPi, timeout: 120_000 }, async () => {
  const dir = withSessionDir();
  const adapter1 = new PiAdapter({ sessionDir: dir, isolateExtensions: true });
  const h1 = await adapter1.start({ cwd: process.cwd(), sessionId: 'contract-002' });
  await (await adapter1.send(h1, { text: 'Reply with exactly: ONE' })).settled;
  await adapter1.stop(h1);

  const adapter2 = new PiAdapter({ sessionDir: dir, isolateExtensions: true });
  // expectExisting：这条会话确实在，所以续跑能通过自检
  const h2 = await adapter2.start({
    cwd: process.cwd(),
    sessionId: 'contract-002',
    expectExisting: true,
  });
  const entries: string[] = [];
  for await (const e of adapter2.history(h2)) entries.push(`${e.role}:${e.text}`);
  assert.ok(entries.some((e) => e.includes('ONE')), `续跑应能看到历史，实际：${entries.join('|')}`);
  await adapter2.stop(h2);
});

test('契约：expectExisting 遇到不存在的会话就报错，不再静默新建', { skip: !hasPi, timeout: 60_000 }, async () => {
  const dir = withSessionDir();
  const adapter = new PiAdapter({ sessionDir: dir, isolateExtensions: true });
  await assert.rejects(
    () => adapter.start({ cwd: process.cwd(), sessionId: 'no-such-session', expectExisting: true }),
    /找不到会话 no-such-session/,
  );
  // 失败得早：还没发过任何消息，所以磁盘上不该留下东西（pi 只在有内容时落盘）
  assert.deepEqual(readdirSync(dir), []);
});

test('契约：不带 expectExisting 时依然是新建（群里首次绑定走这条）', { skip: !hasPi, timeout: 60_000 }, async () => {
  const dir = withSessionDir();
  const adapter = new PiAdapter({ sessionDir: dir, isolateExtensions: true });
  const handle = await adapter.start({ cwd: process.cwd(), sessionId: 'brand-new-001' });
  assert.equal(handle.ref.sessionId, 'brand-new-001');
  await adapter.stop(handle);
});


/* ------------ 决策 33：pi 忙时 followUp 排队 + 超时 abort ------------ */

const fakePi = join(__dirname, 'fake-pi.mjs');
const fakeAdapter = (mode: string, turnTimeoutMs?: number, marker?: string) =>
  new PiAdapter({
    command: fakePi, // shebang 直接执行；adapter 的 --mode rpc 等参数它自己忽略
    sessionDir: withSessionDir(),
    isolateExtensions: true,
    env: {
      FAKE_PI_MODE: mode,
      ...(marker ? { FAKE_PI_MARKER: marker } : {}),
    },
    ...(turnTimeoutMs !== undefined ? { turnTimeoutMs } : {}),
  });

test('契约：pi 还在处理旧 turn → 自动用 followUp 排队重发，而不是把会话卡死', async () => {
  const adapter = fakeAdapter('busy');
  const handle = await adapter.start({ cwd: process.cwd(), sessionId: 'busy-001' });
  const turn = await adapter.send(handle, { text: '继续' });
  const result = await turn.settled;
  assert.equal(result.error, undefined, '第二次（followUp）应该成功');
  assert.match(result.text, /OK/);
  await adapter.stop(handle);
});

test('契约：turn 超时会向 pi 发 abort（决策 33）', async () => {
  const marker = join(withSessionDir(), 'abort-marker.txt');
  const adapter = fakeAdapter('hang', 400, marker);
  const handle = await adapter.start({ cwd: process.cwd(), sessionId: 'hang-001' });
  const turn = await adapter.send(handle, { text: '慢慢来' });
  const result = await turn.settled;
  assert.equal(result.error, 'turn timeout');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(readFileSync(marker, 'utf8'), '1', '超时应向 pi 发 abort 叫停');
  await adapter.stop(handle);
});
