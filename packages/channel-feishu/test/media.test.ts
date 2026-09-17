import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cardContent,
  isWithdrawnReplyError,
  mediaContent,
  mediaMsgType,
  STREAM_ELEMENT_ID,
  streamCardSpec,
  streamSummary,
  textContent,
} from '../src/channel.ts';

/**
 * 出站附件 → 飞书消息形状。上传本身要真调 API（契约测试覆盖），
 * 这里钉的是「分类 + 消息体」这两个容易写错、又不需要网络的判断。
 */
test('图片走 image，其余一律走 file', () => {
  assert.equal(mediaMsgType('image'), 'image');
  assert.equal(mediaMsgType('file'), 'file');
  assert.equal(mediaMsgType('video'), 'file', '视频要封面 image_key，先当文件发');
});

test('消息体是飞书要的 image_key / file_key', () => {
  assert.deepEqual(JSON.parse(mediaContent('image', 'img_v3_abc')), { image_key: 'img_v3_abc' });
  assert.deepEqual(JSON.parse(mediaContent('file', 'file_v3_abc')), { file_key: 'file_v3_abc' });
  assert.deepEqual(JSON.parse(mediaContent('video', 'file_v3_abc')), { file_key: 'file_v3_abc' });
});

test('文本走富文本 post + md 元素（代码块/表格交给飞书渲染）', () => {
  const chunk = '```ts\nconst a = 1\n```';
  assert.deepEqual(JSON.parse(textContent(chunk)), {
    zh_cn: { content: [[{ tag: 'md', text: chunk }]] },
  });
});

test('撤回/找不到的 reply 目标要能认出来（否则这条出站会永远重试）', () => {
  assert.equal(isWithdrawnReplyError({ code: 230011 }), true);
  assert.equal(isWithdrawnReplyError({ code: 231003 }), true);
  assert.equal(isWithdrawnReplyError({ response: { data: { code: 230011 } } }), true);
  assert.equal(isWithdrawnReplyError({ msg: 'the message was withdrawn' }), true);
  assert.equal(isWithdrawnReplyError({ cause: { code: 231003 } }), true, 'axios 会把原因包一层');
  assert.equal(isWithdrawnReplyError({ code: 99991663 }), false, '别的错误码不能吃掉');
  assert.equal(isWithdrawnReplyError(new Error('boom')), false);
  assert.equal(isWithdrawnReplyError(null), false);
});

test('cardContent：schema 2.0 单 markdown 元素卡片（决策 29，抄 xbot buildCard）', () => {
  const card = JSON.parse(cardContent('**粗体** 和 `代码`'));
  assert.equal(card.schema, '2.0');
  assert.equal(card.config.wide_screen_mode, true);
  assert.equal(card.config.update_multi, true, 'update_multi：允许 PATCH 多次更新');
  const md = card.body.elements[0];
  assert.equal(md.tag, 'markdown');
  assert.equal(md.content, '**粗体** 和 `代码`');
  assert.equal(card.body.elements.length, 1, '单元素：文本本身走 markdown 渲染');
});

test('streamCardSpec：streaming_mode + element_id + 打字机参数（决策 32，照 dsh-lark）', () => {
  const card = JSON.parse(streamCardSpec('⏳ 正在处理…'));
  assert.equal(card.schema, '2.0');
  assert.equal(card.config.streaming_mode, true, 'streaming_mode 开启原生流式');
  assert.equal(card.config.streaming_config.print_strategy, 'fast', '显示不落后于 token 速率');
  assert.equal(card.config.summary.content, '[Generating...]');
  const md = card.body.elements[0];
  assert.equal(md.tag, 'markdown');
  assert.equal(md.element_id, STREAM_ELEMENT_ID, '更新接口按 element_id 定位');
  assert.equal(md.content, '⏳ 正在处理…');
});

test('streamSummary：单行 ≤50 字（消息列表预览）', () => {
  assert.equal(streamSummary('  多行\n 结果  '), '多行 结果');
  assert.equal(streamSummary('长'.repeat(60)).length, 50, '超长截断到 50 字');
});
