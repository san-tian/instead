import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TURN_GUIDANCE } from '../src/guidance.ts';

test('引导文案：指向后台异步执行，不是把超时调大', () => {
  assert.match(DEFAULT_TURN_GUIDANCE, /后台/);
  assert.match(DEFAULT_TURN_GUIDANCE, /不要在本轮同步等待/);
  assert.match(DEFAULT_TURN_GUIDANCE, /进度/);
});

test('引导文案：保持中性（决策 21）—— 不出现「飞书/群/机器人」', () => {
  assert.doesNotMatch(DEFAULT_TURN_GUIDANCE, /飞书|群|机器人/);
});
