import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPage } from '../src/index.ts';

const page = (): string => renderPage({ csrf: 'csrf-token-abc', nonce: 'nonce-xyz' });

/* ------------------------------ 安全相关 ------------------------------ */

test('csrf token 注入到 body 的 data 属性', () => {
  assert.match(page(), /data-csrf="csrf-token-abc"/);
});

test('每个 <script>/<style> 都带 nonce（CSP 要求）', () => {
  const html = page();
  const tags = html.match(/<(script|style)\b[^>]*>/g) ?? [];
  assert.ok(tags.length >= 2, `应至少有 script 与 style，实到 ${tags.length}`);
  for (const tag of tags) {
    assert.match(tag, /nonce="nonce-xyz"/, `缺 nonce: ${tag}`);
  }
});

test('不含外链资源（CSP 只允许 self + nonce）', () => {
  const html = page();
  assert.equal(/<script[^>]+src=/.test(html), false, '不应有外链 script');
  assert.equal(/<link[^>]+href="https?:/.test(html), false, '不应有外链样式');
});

/* ------------------------------ 改名残留 ------------------------------ */

test('页面里没有旧名残留', () => {
  assert.equal(/lark-echo|Lark Echo/i.test(page()), false);
});

/* ---------------------------- 客户端脚本自洽 ---------------------------- */

/** 取出内联脚本正文 */
function clientScript(html: string): string {
  const m = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
  assert.ok(m, '找不到内联脚本');
  return m[1]!;
}

test('客户端脚本语法合法', () => {
  const js = clientScript(page());
  assert.doesNotThrow(() => new Function(js), '客户端 JS 有语法错误');
});

test('每个 patch() 目标 id 在 HTML 里真实存在', () => {
  // 差量渲染靠 id 找挂载点；打错一个字就静默不更新，这里兜住
  const html = page();
  const ids = [...clientScript(html).matchAll(/patch\('([a-z-]+)'/g)].map((m) => m[1]!);
  assert.ok(ids.length > 0, '没找到 patch 调用');
  const missing = [...new Set(ids)].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `patch 目标缺失: ${missing.join(', ')}`);
});

/* ------------------------------ 可访问性 ------------------------------ */

test('toasts 容器有 aria-live，屏幕阅读器能播报', () => {
  assert.match(page(), /id="toasts"[^>]*aria-live="polite"/);
});

test('每个 <select> 都有可访问名（label for 或 aria-label）', () => {
  const html = page();
  const selects = html.match(/<select\b[^>]*>/g) ?? [];
  assert.ok(selects.length > 0, '页面应有下拉');
  for (const s of selects) {
    const id = s.match(/id="([^"]+)"/)?.[1];
    const named =
      /aria-label="/.test(s) || (id !== undefined && html.includes(`for="${id}"`));
    assert.ok(named, `下拉缺可访问名: ${s}`);
  }
});

test('.sr-only 有定义（表头靠它对屏幕阅读器可见）', () => {
  assert.match(page(), /\.sr-only\s*\{/);
});

test('尊重 prefers-reduced-motion', () => {
  assert.match(page(), /@media\s*\(prefers-reduced-motion/);
});

/* ------------------------------ 渲染稳定性 ------------------------------ */

test('同样输入渲染结果一致（差量比对依赖这点）', () => {
  const a = renderPage({ csrf: 'c', nonce: 'n' });
  const b = renderPage({ csrf: 'c', nonce: 'n' });
  assert.equal(a, b, '渲染必须是纯函数，否则每轮轮询都会误判成有变化');
});

test('nonce 变化只影响 nonce 属性，不影响结构', () => {
  const a = renderPage({ csrf: 'c', nonce: 'n1' }).replaceAll('n1', 'N');
  const b = renderPage({ csrf: 'c', nonce: 'n2' }).replaceAll('n2', 'N');
  assert.equal(a, b);
});

/* ---------------------------- 改版后的结构 ---------------------------- */

test('骨架挂载点齐全（tab / 视图 / 两个对话框）', () => {
  const html = page();
  for (const id of ['tabs', 'view', 'daemon', 'toasts', 'confirm', 'choose']) {
    assert.match(html, new RegExp(`id="${id}"`), `缺挂载点 #${id}`);
  }
});

test('客户端只调真实存在的写接口', () => {
  // 改版时我凭记忆写了个 /api/mirror，实际不存在（决策 17 已废弃 mirror）。
  // 这条锁住：脚本里 api('POST', ...) 的路径必须在白名单内。
  const REAL = new Set([
    '/api/bind', '/api/unbind', '/api/switch-agent', '/api/model', '/api/default-model', '/api/settings',
    '/api/session/release', '/api/doctor/refresh', '/api/chats/refresh',
    '/api/outbound/flush', '/api/outbound/discard', '/api/code', '/api/code/delete',
  ]);
  const js = clientScript(page());
  const called = [...js.matchAll(/api\('POST',\s*'([^']+)'/g)].map((m) => m[1]!);
  assert.ok(called.length > 0, '应该有写操作');
  const bogus = [...new Set(called)].filter((p) => !REAL.has(p));
  assert.deepEqual(bogus, [], `调用了不存在的接口: ${bogus.join(', ')}`);
});

test('读接口也都是真实存在的', () => {
  const REAL = new Set(['/api/state', '/api/fs', '/api/members', '/api/models', '/api/sessions']);
  const js = clientScript(page());
  const called = [...js.matchAll(/(?:getJSON|fetch)\('(\/api\/[a-z/-]+)/g)].map((m) => m[1]!);
  const bogus = [...new Set(called)].filter((p) => !REAL.has(p));
  assert.deepEqual(bogus, [], `读了不存在的接口: ${bogus.join(', ')}`);
});

test('不引用 session.ref.*（/api/state 里 session 是扁平的）', () => {
  // UiSession 是 {sessionId, agent, cwd, driver, idleMs, model, capabilities}，
  // 没有 ref 这层 —— 写成 s.ref.sessionId 会渲染出 undefined。
  const js = clientScript(page());
  assert.equal(/\.ref\.(sessionId|agent|cwd)/.test(js), false, '不该有 .ref. 层级');
});

test('mirror 已彻底移除（决策 17 废弃）', () => {
  assert.equal(/mirror/i.test(page()), false);
});

test('向导五步齐全，且「选会话」排在目录与 agent 之后', () => {
  const js = clientScript(page());
  const m = js.match(/STEPS\s*=\s*\[([^\]]+)\]/);
  assert.ok(m, '找不到 STEPS');
  const steps = m[1]!.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
  assert.equal(steps.length, 5, `向导应为 5 步，实际 ${steps.join(' → ')}`);
  const iDir = steps.indexOf('选目录');
  const iAgent = steps.indexOf('选 agent');
  const iSession = steps.indexOf('选会话');
  assert.ok(
    iSession > iDir && iSession > iAgent,
    '可接管的会话取决于目录与 agent，必须排在它们之后',
  );
});

test('接管已有会话时必须带 resumeExisting（否则 opaque adapter 静默新建）', () => {
  // 回归：claude/codex 在 SessionPool 里只认 session_aliases。绑定时不写别名，
  // 传给 adapter 的 sessionId 就是 undefined → 新建空会话，用户选的被忽略。
  const js = clientScript(page());
  assert.match(js, /resumeExisting:\s*resume/, 'bind 载荷要带 resumeExisting');
  assert.match(js, /wiz\.resume && Boolean\(wiz\.sessionId\)/, 'resume 要同时要求选中了具体会话');
  assert.match(js, /resume \? wiz\.sessionId : 'is-'/, '接管用选中的 id，新建才生成');
});

test('换 agent 会清掉已选会话（会话 id 不跨 agent 通用）', () => {
  const js = clientScript(page());
  const block = /a === 'w-agent'[\s\S]{0,500}?\n  \}/.exec(js)?.[0] ?? '';
  assert.ok(block, '找不到 w-agent 分支');
  assert.match(block, /wiz\.sessionId = ''/, '换 agent 要清 sessionId');
  assert.match(block, /wiz\.resume = false/);
});

test('会话列表加载中时不放行下一步', () => {
  // sessions === null 表示还在飞行中；此时点下一步会带着空选择走掉
  const js = clientScript(page());
  assert.match(js, /wiz\.step === 3 \? wiz\.sessions !== null/);
});

test('危险操作走确认对话框，不用原生 confirm', () => {
  const js = clientScript(page());
  assert.equal(/(?<!\w)confirm\s*\(/.test(js.replace(/confirmDlg\s*\(/g, '')), false,
    '不应直接调原生 confirm()');
  assert.match(js, /confirmDlg\(/, '应使用自绘确认框');
  // 断开连接与重启会话都必须确认
  assert.match(js, /a === 'unbind'[\s\S]{0,200}confirmDlg/);
  assert.match(js, /a === 'release'[\s\S]{0,200}confirmDlg/);
});

test('列表模式下隐藏「保存」按钮（它只读自由输入框）', () => {
  const js = clientScript(page());
  assert.match(js, /saveBtn\.style\.display\s*=\s*free\s*\?/,
    '有模型列表时必须隐藏保存按钮，否则会把已选模型重置成默认');
});

/* ---------------------------- 目录选择器可手输 ---------------------------- */

test('目录步有可手输的地址栏（带可访问名，说明支持 ~）', () => {
  const js = clientScript(page());
  assert.match(js, /id="w-cwd"/, '要有路径输入框');
  assert.match(js, /aria-label="目录路径（可直接输入，支持 ~\/）"/);
  assert.match(js, /data-act="w-goto"/, '要有跳转按钮');
  assert.match(js, /for="w-cwd"/, 'input 要有对应 label');
});

test('地址栏回车即跳转，且不提交页面', () => {
  const js = clientScript(page());
  assert.match(js, /ev\.key === 'Enter'[\s\S]{0,80}w-cwd/, '回车要绑在地址栏上');
  assert.match(js, /ev\.preventDefault\(\)/);
  assert.equal(/<form[^>]*w-cwd/.test(js), false, '不该包在 form 里（会把整页提交掉）');
});

test('跳转失败显示错误、不假装成功', () => {
  const js = clientScript(page());
  assert.match(js, /d\.error/, '要读服务端的 error');
  assert.match(js, /dirError/, '要把它挂到界面上');
  assert.match(js, /el\.focus\(\)/, '失败后焦点回到地址栏，方便改错');
});

test('目录列表端点带 path 参数走真实接口', () => {
  const js = clientScript(page());
  assert.match(js, /getJSON\('\/api\/fs'/);
  assert.match(js, /encodeURIComponent\(path\)/);
});

/* ---------------------------- 换模型流程 ---------------------------- */

test('loadModels 按 {models:[...]} 取列表（兼容老版本裸数组）', () => {
  const js = clientScript(page());
  assert.match(js, /Array\.isArray\(list\) \? list : \(list && list\.models\)/);
});

test('换模型的结果按 applied 区分提示：runtime = 立即生效', () => {
  const js = clientScript(page());
  assert.match(js, /applied === 'runtime'/);
  assert.match(js, /立即生效/);
  assert.match(js, /下次启动会话生效/);
});

test('换模型对话框的提示区分在线/空闲/需重启三种', () => {
  const js = clientScript(page());
  assert.match(js, /会话在线，切换立即生效/);
  assert.match(js, /会话空闲，保存后下次启动生效/);
});

test('会话步的「新建」写明目录（用户才知道会落在哪）', () => {
  const js = clientScript(page());
  assert.match(js, /在这个目录下开一条新会话/);
  assert.match(js, /空白上下文 · /);
  assert.match(js, /ID 自动生成/);
});
