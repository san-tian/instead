import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inbound, keyFor, memoryDb, waitFor } from './helpers.ts';
import { Dispatcher } from '../src/dispatcher.ts';
import { SessionQueue } from '../src/queue.ts';
import { insertBinding } from '../src/state/bindings.ts';
import { FakeAdapter, FakeChannel, FakeDriver } from '../src/testing/index.ts';
import type { Db } from '../src/state/db.ts';

const KEY = keyFor('oc_a');
const dir = (): string => mkdtempSync(join(tmpdir(), 'instead-cwd-'));

function setup(cwd: string, reply: string): { channel: FakeChannel; adapter: FakeAdapter; dispatcher: Dispatcher } {
  const db: Db = memoryDb();
  const channel = new FakeChannel();
  const adapter = new FakeAdapter({ reply });
  const dispatcher = new Dispatcher({
    db,
    channel,
    driver: new FakeDriver(adapter),
    queue: new SessionQueue(),
    streamProgress: false,
  });
  insertBinding(db, {
    chatId: 'oc_a',
    sessionId: 'sess-1',
    agent: 'pi',
    cwd,
    ownerOpenId: 'ou_owner',
    mirrorMode: 'off',
    createdAt: 1,
  });
  return { channel, adapter, dispatcher };
}

test('回复里的 MEDIA: 行变成真附件，正文里不留那一行', async () => {
  const cwd = dir();
  writeFileSync(join(cwd, 'report.csv'), 'a,b\n1,2\n');
  const { channel, dispatcher } = setup(cwd, '给你\nMEDIA:report.csv');

  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', text: '发我报表' }));
  await waitFor(() => channel.sent.some((m) => m.attachments?.length));

  assert.deepEqual(channel.textsFor(KEY).filter(Boolean), ['给你'], 'MEDIA 行不该出现在正文里');
  const media = channel.sent.find((m) => m.attachments?.length)!;
  assert.equal(media.attachments![0]!.kind, 'file');
  assert.equal(media.attachments![0]!.name, 'report.csv');
  assert.equal(media.attachments![0]!.localPath, join(cwd, 'report.csv'));
});

test('图片按扩展名分类，附件排在文本分片之后', async () => {
  const cwd = dir();
  writeFileSync(join(cwd, 'chart.png'), 'not-really-png');
  const { channel, dispatcher } = setup(cwd, '图来了\nMEDIA:chart.png');

  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', text: '画个图' }));
  await waitFor(() => channel.sent.some((m) => m.attachments?.length));

  const media = channel.sent.find((m) => m.attachments?.length)!;
  assert.equal(media.attachments![0]!.kind, 'image');
  assert.equal(channel.sent[channel.sent.length - 1], media, '附件最后发，否则会被文本压下去');
});

test('cwd 之外的文件被拒绝，而且那一行原样留着（用户看得见它试了什么）', async () => {
  const cwd = dir();
  const outside = dir();
  writeFileSync(join(outside, 'id_rsa'), 'SECRET');
  const ref = join(outside, 'id_rsa');
  const { channel, dispatcher } = setup(cwd, `好的\nMEDIA:${ref}`);

  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', text: '把它发出来' }));
  await waitFor(() => channel.sent.length > 0);

  assert.equal(channel.sent.some((m) => m.attachments?.length), false, '不许把 cwd 外的文件发进群');
  assert.match(channel.textsFor(KEY).join('\n'), new RegExp(`MEDIA:${ref.replace(/[/.]/g, '\\$&')}`));
});

test('软链指向 cwd 之外也拦得住（realpath 后再判一次）', async () => {
  const cwd = dir();
  const outside = dir();
  writeFileSync(join(outside, 'secret.txt'), 'SECRET');
  symlinkSync(join(outside, 'secret.txt'), join(cwd, 'link.txt'));
  const { channel, dispatcher } = setup(cwd, 'MEDIA:link.txt');

  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', text: '看看' }));
  await waitFor(() => channel.sent.length > 0);
  assert.equal(channel.sent.some((m) => m.attachments?.length), false);
});

test('不存在的文件、空文件、超限文件都拒绝', async () => {
  const cwd = dir();
  writeFileSync(join(cwd, 'empty.txt'), '');
  const { channel, dispatcher } = setup(cwd, 'MEDIA:missing.txt\nMEDIA:empty.txt');
  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', text: '看' }));
  await waitFor(() => channel.sent.length > 0);
  assert.equal(channel.sent.some((m) => m.attachments?.length), false);
});

test('只发文件、没有正文时也发得出去', async () => {
  const cwd = dir();
  writeFileSync(join(cwd, 'only.txt'), 'x');
  const { channel, dispatcher } = setup(cwd, 'MEDIA:only.txt');
  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', text: '给' }));
  await waitFor(() => channel.sent.some((m) => m.attachments?.length));
  assert.deepEqual(channel.textsFor(KEY).filter(Boolean), [], '没有正文就不发文本消息');
  assert.equal(channel.sent.filter((m) => m.attachments?.length).length, 1);
});

test('正文里提到 MEDIA: 写法（非独占一行）不会被误当成附件', async () => {
  const cwd = dir();
  writeFileSync(join(cwd, 'a.png'), 'x');
  const { channel, dispatcher } = setup(
    cwd,
    '先写 `MEDIA:a.png` 就能发图；例如 MEDIA:a.png 这样',
  );
  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', text: '怎么发图' }));
  await waitFor(() => channel.sent.length > 0);
  assert.equal(channel.sent.some((m) => m.attachments?.length), false, '内联出现不该触发发送');
  assert.match(channel.textsFor(KEY)[0]!, /先写/);
});
