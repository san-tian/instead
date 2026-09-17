#!/usr/bin/env node
/**
 * fake pi CLI（决策 33 测试用）：按 stdin 的 JSONL 回话。
 * 行为由 FAKE_PI_MODE 控制：
 * - ok（默认）：prompt 直接回 delta + agent_settled
 * - busy：第一次 prompt（不带 streamingBehavior）拒绝
 *   「Agent is already processing…」；带 followUp 的正常回
 * - hang：prompt 回 success 但永不 settle（超时测试用）
 *
 * abort 收到后把次数写到 FAKE_PI_MARKER 文件（超时测试断言用）。
 */
const mode = process.env.FAKE_PI_MODE || 'ok';
const marker = process.env.FAKE_PI_MARKER || '';

import { writeFileSync } from 'node:fs';

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const respondOk = (obj, data = {}) => out({ type: 'response', id: obj.id, success: true, data });
let abortCount = 0;

function handle(obj) {
  if (obj.type === 'abort') {
    abortCount++;
    if (marker) writeFileSync(marker, String(abortCount));
    return;
  }
  if (obj.type === 'prompt') {
    if (mode === 'busy' && obj.streamingBehavior !== 'followUp') {
      out({
        type: 'response',
        id: obj.id,
        success: false,
        error:
          "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
      });
      return;
    }
    if (mode === 'hang') {
      respondOk(obj);
      return; // 永不 settle
    }
    respondOk(obj);
    out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'OK' } });
    out({ type: 'agent_settled' });
    return;
  }
  // get_session_stats / get_last_assistant_text / 其他：一律成功
  if (obj.type === 'get_session_stats') {
    respondOk(obj, { sessionId: 'fake-sess', sessionFile: '/tmp/fake-session.jsonl' });
    return;
  }
  if (obj.type === 'get_last_assistant_text') {
    respondOk(obj, { text: null });
    return;
  }
  if (obj.id) respondOk(obj);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    handle(obj);
  }
});
