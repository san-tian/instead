import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inbound, keyFor, memoryDb, waitFor } from './helpers.ts';
import { Dispatcher } from '../src/dispatcher.ts';
import { SessionQueue } from '../src/queue.ts';
import { insertBinding } from '../src/state/bindings.ts';
import { FakeAdapter, FakeChannel, FakeDriver } from '../src/testing/index.ts';
import type { Db } from '../src/state/db.ts';

/** 1x1 PNG，够小够真 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function setup() {
  const db: Db = memoryDb();
  const channel = new FakeChannel();
  const adapter = new FakeAdapter({ reply: '看到了' });
  const driver = new FakeDriver(adapter);
  const dispatcher = new Dispatcher({ db, channel, driver, queue: new SessionQueue(), streamProgress: false });
  insertBinding(db, {
    chatId: 'oc_a',
    sessionId: 'sess-1',
    agent: 'pi',
    cwd: '/repo',
    ownerOpenId: 'ou_owner',
    mirrorMode: 'off',
    createdAt: 1,
  });
  return { db, channel, adapter, dispatcher };
}

const mediaDir = (): string => mkdtempSync(join(tmpdir(), 'instead-media-'));

test('入站图片进 UserMessage.images，而不是只给一句「[图片]」', async () => {
  const { channel, adapter, dispatcher } = setup();
  const file = join(mediaDir(), 'shot.png');
  writeFileSync(file, PNG);
  channel.downloads.set('img_key_1', {
    localPath: file,
    name: 'shot.png',
    mimeType: 'image/png',
    bytes: PNG.length,
  });

  await dispatcher.handleInbound(
    inbound({
      chatId: 'oc_a',
      text: '看看这张',
      attachments: [{ kind: 'image', key: 'img_key_1' }],
    }),
  );
  await waitFor(() => channel.sent.length > 0);

  const sent = adapter.received[0]!;
  assert.equal(sent.text, '[张三] 看看这张', '图片不该污染正文');
  assert.equal(sent.images?.length, 1);
  assert.equal(sent.images?.[0]?.mimeType, 'image/png');
  assert.equal(sent.images?.[0]?.data, PNG.toString('base64'));
});

test('入站文件落盘，把路径写进正文（agent 自己读）', async () => {
  const { channel, adapter, dispatcher } = setup();
  const path = join(mediaDir(), '20260910-报表.csv');
  channel.downloads.set('file_key_1', {
    localPath: path,
    name: '报表.csv',
    mimeType: 'text/csv',
    bytes: 12,
  });

  await dispatcher.handleInbound(
    inbound({
      chatId: 'oc_a',
      text: '看一下这个表',
      attachments: [{ kind: 'file', key: 'file_key_1', name: '报表.csv' }],
    }),
  );
  await waitFor(() => channel.sent.length > 0);

  const sent = adapter.received[0]!;
  assert.equal(sent.images, undefined, '文件不走 images');
  assert.match(sent.text, /^\[张三\] 看一下这个表\n\[文件: 报表\.csv 已保存到 /);
  assert.ok(sent.text.includes(path), '要给绝对路径，agent 才能直接读');
});

test('语音/视频用中文标签，不是「文件」', async () => {
  const { channel, adapter, dispatcher } = setup();
  channel.downloads.set('v1', { localPath: '/tmp/v.mp4', name: 'v.mp4', bytes: 1 });
  await dispatcher.handleInbound(
    inbound({ chatId: 'oc_a', text: '看视频', attachments: [{ kind: 'video', key: 'v1' }] }),
  );
  await waitFor(() => channel.sent.length > 0);
  assert.match(adapter.received[0]!.text, /\[视频: v\.mp4 已保存到 \/tmp\/v\.mp4\]/);
});

test('下载失败只丢那一条附件，这一轮照常跑', async () => {
  const { channel, adapter, dispatcher } = setup();
  await dispatcher.handleInbound(
    inbound({
      chatId: 'oc_a',
      text: '文件在这',
      attachments: [{ kind: 'file', key: 'missing', name: 'a.pdf' }],
    }),
  );
  await waitFor(() => channel.sent.length > 0);

  assert.equal(adapter.received.length, 1, '附件失败不能把这一轮吞掉');
  assert.match(adapter.received[0]!.text, /\[附件未能下载：file\]/);
});

test('图片落盘了但读不出来时，降级成路径说明而不是崩掉', async () => {
  const { channel, adapter, dispatcher } = setup();
  channel.downloads.set('img_gone', {
    localPath: join(mediaDir(), '不存在的图.png'),
    name: '不存在的图.png',
    mimeType: 'image/png',
    bytes: 1,
  });
  await dispatcher.handleInbound(
    inbound({ chatId: 'oc_a', text: '图', attachments: [{ kind: 'image', key: 'img_gone' }] }),
  );
  await waitFor(() => channel.sent.length > 0);

  const sent = adapter.received[0]!;
  assert.equal(sent.images, undefined);
  assert.match(sent.text, /\[图片: 不存在的图\.png 已保存到 /);
});

test('没 @ 的旁观消息不下载附件（省流量，也避免盲拉群里的图）', async () => {
  const { channel, dispatcher } = setup();
  await dispatcher.handleInbound(
    inbound({
      chatId: 'oc_a',
      mentioned: false,
      text: '随便发张图',
      attachments: [{ kind: 'image', key: 'img_key_1' }],
    }),
  );
  assert.equal(channel.downloadCount, 0);
});

test('没有附件时不碰 channel.downloadAttachment', async () => {
  const { channel, dispatcher } = setup();
  await dispatcher.handleInbound(inbound({ chatId: 'oc_a', text: '纯文本' }));
  await waitFor(() => channel.sent.length > 0);
  assert.equal(channel.downloadCount, 0);
  assert.equal(keyFor('oc_a'), 'feishu:chat:oc_a'); // 保持 helper 被使用
});

test('不支持图片的 agent（如 claude）：图片落盘给路径，而不是整轮失败（决策 26）', async () => {
  const { channel, adapter, dispatcher } = (function () {
    const db: Db = memoryDb();
    const channel = new FakeChannel();
    const adapter = new FakeAdapter({ reply: '看到了', images: false });
    const dispatcher = new Dispatcher({ db, channel, driver: new FakeDriver(adapter), queue: new SessionQueue(), streamProgress: false });
    insertBinding(db, {
      chatId: 'oc_a', sessionId: 'sess-1', agent: 'claude', cwd: '/repo',
      ownerOpenId: 'ou_owner', mirrorMode: 'off', createdAt: 1,
    });
    return { channel, adapter, dispatcher };
  })();

  const file = join(mediaDir(), 'shot.png');
  writeFileSync(file, PNG);
  channel.downloads.set('img_key_2', {
    localPath: file, name: 'shot.png', mimeType: 'image/png', bytes: PNG.length,
  });
  await dispatcher.handleInbound(
    inbound({ chatId: 'oc_a', text: '看看这张', attachments: [{ kind: 'image', key: 'img_key_2' }] }),
  );
  await waitFor(() => channel.sent.length > 0);

  const sent = adapter.received[0]!;
  assert.equal(sent.images, undefined, '不支持图片就不塞 images');
  assert.match(sent.text, /\[图片: shot\.png 已保存到 /, '退化成路径说明，agent 自己能读');
});
