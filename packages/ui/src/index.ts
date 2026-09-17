/**
 * Web 配置台的 SSR 壳 + 客户端脚本（DESIGN §4.4）。
 * 无前端框架、无构建步骤：一张页面 + 原生 JS，每 2 秒轮询 /api/state。
 *
 * 两条设计约束：
 * 1. **差量更新**：按区块比对 HTML，只重绘变了的部分。全量重绘会打断
 *    正在输入的表单、下拉选择和滚动位置。
 * 2. **一次只让人做一个决定**：主界面只放「现在连着哪些群」，连新群走
 *    分步向导，运维面板收进 tab。不要 9 个区块平铺。
 */

export interface PageOptions {
  csrf: string;
  nonce: string;
}

const CSS = `
:root{--bg:#0a0c11;--panel:#12151d;--panel-2:#191d27;--panel-3:#1f2430;--line:#252b39;--line-soft:#1b212c;--fg:#e9ecf3;--dim:#98a1b3;--dim-2:#626b7b;--accent:#6c8cff;--accent-2:#8aa6ff;--accent-soft:rgba(108,140,255,.12);--ok:#34d399;--warn:#f5a623;--bad:#f87171;--r:12px;--shadow:0 10px 30px -18px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,.02)}
*{box-sizing:border-box}
html{color-scheme:dark}
body{margin:0;background:var(--bg);color:var(--fg);font:13.5px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
button,input,select{font:inherit}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dim{color:var(--dim)}
.ok{color:var(--ok)}
.bad{color:var(--bad)}

/* ---------- 顶栏 ---------- */
header{display:flex;align-items:center;gap:14px;padding:12px 20px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:40}
.logo{width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,var(--accent),#7c5cff);display:grid;place-items:center;font-size:15px;color:#fff;flex-shrink:0}
h1{font-size:14.5px;margin:0;font-weight:650}
header .spacer{flex:1}
.status{display:inline-flex;align-items:center;gap:7px;padding:4px 11px;border-radius:999px;font-size:12px;border:1px solid var(--line);background:var(--panel-2)}
.status.up{color:var(--ok);border-color:rgba(52,211,153,.3)}
.status.down{color:var(--bad);border-color:rgba(248,113,113,.3)}
.dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0}

/* ---------- tab ---------- */
nav{display:flex;gap:2px;padding:0 20px;border-bottom:1px solid var(--line);background:var(--panel);overflow-x:auto;position:sticky;top:55px;z-index:39}
nav button{background:none;border:none;border-bottom:2px solid transparent;color:var(--dim);padding:10px 14px;font-size:13px;cursor:pointer;white-space:nowrap}
nav button:hover{color:var(--fg)}
nav button[aria-selected=true]{color:var(--accent-2);border-bottom-color:var(--accent)}
nav .count{font-size:11px;color:var(--dim-2);margin-left:5px}
main{padding:20px;max-width:1080px;margin:0 auto}

/* ---------- 连接卡片（主界面）---------- */
.cards{display:grid;gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:14px 16px;box-shadow:var(--shadow)}
.card-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.chat-name{font-size:15px;font-weight:600}
.card-top .spacer{flex:1}
.meta{display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:12.5px;color:var(--dim)}
.meta b{color:var(--fg);font-weight:500}
.card-actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;align-items:center}
.badge{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;border:1px solid var(--line);font-size:11.5px;color:var(--dim);background:var(--panel-2)}
.badge.live{color:var(--ok);border-color:rgba(52,211,153,.3)}
.badge.idle{color:var(--dim)}

/* ---------- 空状态 ---------- */
.empty{text-align:center;padding:44px 20px;background:var(--panel);border:1px dashed var(--line);border-radius:var(--r)}
.empty h3{margin:0 0 6px;font-size:15px;font-weight:600}
.empty p{margin:0 0 18px;color:var(--dim);font-size:13px}

/* ---------- 按钮 ---------- */
button.btn{background:var(--panel-2);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:6px 13px;font-size:12.5px;cursor:pointer;transition:background .12s,border-color .12s}
button.btn:hover:not(:disabled){border-color:var(--accent);background:var(--accent-soft)}
button.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:500}
button.btn.primary:hover:not(:disabled){background:var(--accent-2);border-color:var(--accent-2)}
button.btn.danger:hover:not(:disabled){border-color:var(--bad);color:var(--bad);background:rgba(248,113,113,.08)}
button.btn.lg{padding:9px 20px;font-size:13.5px}
button.btn:disabled{opacity:.45;cursor:not-allowed}
button.link{background:none;border:none;color:var(--accent-2);cursor:pointer;padding:0;font-size:12.5px;text-decoration:underline}

/* ---------- 表单 ---------- */
label{font-size:12.5px;color:var(--dim);display:block;margin-bottom:5px}
input[type=text],input[type=number],select{width:100%;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:8px 11px;font-size:13px}
input:focus,select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.field{margin-bottom:14px}
.field .hint{font-size:11.5px;color:var(--dim-2);margin-top:5px}
.inline{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
.inline>.field{flex:1;min-width:150px;margin-bottom:0}

/* ---------- 选择列表（群 / 目录 / 会话）---------- */
.picker{border:1px solid var(--line);border-radius:8px;background:var(--bg);max-height:260px;overflow-y:auto}
.pick{display:flex;align-items:center;gap:10px;width:100%;background:none;border:none;border-bottom:1px solid var(--line-soft);color:var(--fg);padding:10px 12px;font-size:13px;cursor:pointer;text-align:left}
.pick:last-child{border-bottom:none}
.pick:hover{background:var(--accent-soft)}
.pick[aria-selected=true]{background:var(--accent-soft);color:var(--accent-2)}
.pick .sub{font-size:11.5px;color:var(--dim-2)}
.pick .grow{flex:1;min-width:0}
.pick .tick{color:var(--accent);flex-shrink:0}
.pick:disabled{opacity:.5;cursor:not-allowed}
.pick:disabled:hover{background:none}

/* ---------- 向导 ---------- */
.steps{display:flex;gap:6px;margin-bottom:18px;font-size:12px;flex-wrap:wrap}
.steps span{display:flex;align-items:center;gap:6px;color:var(--dim-2)}
.steps span::after{content:"›";margin-left:4px;color:var(--line)}
.steps span:last-child::after{content:""}
.steps span.now{color:var(--accent-2);font-weight:600}
.steps span.done{color:var(--ok)}
.wizard-foot{display:flex;gap:10px;justify-content:space-between;margin-top:18px;padding-top:16px;border-top:1px solid var(--line)}
.crumb{display:flex;gap:4px;align-items:center;font-size:12px;flex-wrap:wrap;margin-bottom:8px}
.crumb button{background:none;border:none;color:var(--accent-2);cursor:pointer;font-size:12px;padding:2px 4px;border-radius:4px}
.crumb button:hover{background:var(--accent-soft)}
.crumb span{color:var(--dim-2)}

/* ---------- 表格（运维 tab）---------- */
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--panel)}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line-soft)}
th{color:var(--dim);font-weight:550;font-size:11px;text-transform:uppercase;letter-spacing:.05em;background:var(--panel-2)}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover{background:rgba(108,140,255,.04)}
.section{margin-bottom:26px}
.section h2{font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.07em;margin:0 0 10px;font-weight:600}
fieldset{border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:0 0 14px;background:var(--panel)}
legend{font-size:12px;color:var(--fg);font-weight:600;padding:0 6px}

/* ---------- toast / 对话框 ---------- */
.toasts{position:fixed;bottom:20px;right:20px;z-index:120;display:grid;gap:8px;max-width:340px}
.toast{padding:11px 14px;border-radius:9px;font-size:12.5px;background:var(--panel-3);border:1px solid var(--line);box-shadow:0 10px 28px -12px rgba(0,0,0,.8);animation:in .18s ease}
.toast.ok{border-color:rgba(52,211,153,.4);color:var(--ok)}
.toast.error{border-color:rgba(248,113,113,.4);color:var(--bad)}
.toast.out{opacity:0;transform:translateY(6px);transition:all .25s}
@keyframes in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
dialog{border:1px solid var(--line);border-radius:var(--r);background:var(--panel);color:var(--fg);padding:0;max-width:420px;box-shadow:0 24px 60px -20px rgba(0,0,0,.85)}
dialog::backdrop{background:rgba(0,0,0,.62)}
dialog .dlg-t{padding:15px 18px;font-weight:600;border-bottom:1px solid var(--line)}
dialog .dlg-b{padding:16px 18px;color:var(--dim);line-height:1.65;font-size:13px}
dialog .dlg-f{padding:12px 16px;display:flex;gap:9px;justify-content:flex-end;border-top:1px solid var(--line)}
.spin{width:12px;height:12px;border:2px solid var(--accent-soft);border-top-color:var(--accent);border-radius:50%;animation:sp .7s linear infinite;display:inline-block}
@keyframes sp{to{transform:rotate(360deg)}}
#saving{position:fixed;bottom:20px;left:20px;z-index:120;display:none;align-items:center;gap:8px;padding:7px 14px;border-radius:999px;background:var(--panel-3);border:1px solid var(--accent);font-size:12.5px}
body.busy #saving{display:inline-flex}

@media (max-width:640px){
  header,nav,main{padding-left:14px;padding-right:14px}
  nav{top:53px}
  .inline>.field{min-width:100%}
  .wizard-foot{flex-direction:column-reverse}
  .wizard-foot button{width:100%}
}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}}
`;

// 客户端脚本：原生 JS。刻意不用模板字符串，避免和外层 TS 模板冲突。
const CLIENT_JS = `
var CSRF = document.body.dataset.csrf;
var state = null;
var busy = false;
var tab = 'connections';
var lastHtml = {};
var modelsCache = {};

/* 向导状态：只在向导打开时有值 */
var wiz = null;

function api(method, path, body) {
  return fetch(path, {
    method: method,
    headers: { 'content-type': 'application/json', 'x-csrf-token': CSRF },
    body: body ? JSON.stringify(body) : undefined
  }).then(function (r) {
    return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.statusText); return j; });
  });
}
function getJSON(p) { return fetch(p).then(function (r) { return r.json(); }); }

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function ago(ms) {
  var s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + ' 秒';
  var m = Math.round(s / 60);
  if (m < 60) return m + ' 分钟';
  return Math.round(m / 60) + ' 小时';
}
function shortId(id) { return String(id || '').length > 14 ? String(id).slice(0, 11) + '…' : String(id || ''); }
function tail(p) { var x = String(p || '').split('/').filter(Boolean); return x.length ? x[x.length - 1] : '/'; }

function toast(msg, kind) {
  var box = document.getElementById('toasts');
  var t = document.createElement('div');
  t.className = 'toast ' + (kind || 'info');
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(function () { t.classList.add('out'); setTimeout(function () { t.remove(); }, 260); }, 3400);
}

function confirmDlg(title, msg, okLabel) {
  return new Promise(function (resolve) {
    var d = document.getElementById('confirm');
    d.querySelector('.dlg-t').textContent = title;
    d.querySelector('.dlg-b').textContent = msg;
    d.querySelector('#c-yes').textContent = okLabel || '确定';
    d.showModal();
    d.onclose = function () { resolve(d.returnValue === 'yes'); };
  });
}

/** 只在内容变化时写 DOM —— 否则 2 秒一次的轮询会打断输入与滚动 */
function patch(id, html) {
  var el = document.getElementById(id);
  if (!el || lastHtml[id] === html) return;
  lastHtml[id] = html;
  el.innerHTML = html;
}

function act(fn, okMsg) {
  if (busy) return Promise.resolve();
  busy = true;
  document.body.classList.add('busy');
  return fn()
    .then(function (r) {
      var msg = typeof okMsg === 'function' ? okMsg(r) : okMsg;
      if (msg) toast(msg, 'ok');
      return r;
    })
    .catch(function (e) { toast(e.message || String(e), 'error'); throw e; })
    .finally(function () { busy = false; document.body.classList.remove('busy'); refresh(); });
}

/* ══════════════ 主界面：连接卡片 ══════════════ */

function sessionOf(chatId) {
  if (!state) return null;
  var b = state.bindings.filter(function (x) { return x.chatId === chatId; })[0];
  if (!b) return null;
  return state.sessions.filter(function (s) { return s.sessionId === b.sessionId; })[0] || null;
}

function renderConnections() {
  if (!state.bindings.length) {
    return '<div class="empty"><h3>还没有连接任何群</h3>' +
      '<p>把一个飞书群连到本地目录，群里 @机器人 就能跑 agent。</p>' +
      '<button class="btn primary lg" data-act="wizard">连接一个群</button></div>';
  }
  var cards = state.bindings.map(function (b) {
    var live = sessionOf(b.chatId);
    var name = b.name || shortId(b.chatId);
    // §4.4.2 约束 1：改了没用的控件就不给
    var canModel = !live || live.capabilities.modelSwitch !== 'none';
    return '<div class="card">' +
      '<div class="card-top">' +
        '<span class="chat-name">' + esc(name) + '</span>' +
        '<span class="badge ' + (live ? 'live' : 'idle') + '"><span class="dot"></span>' +
          (live ? '会话活跃' : '空闲') + '</span>' +
        '<span class="spacer"></span>' +
        '<span class="dim mono" style="font-size:11.5px">' + esc(shortId(b.chatId)) + '</span>' +
      '</div>' +
      '<div class="meta">' +
        '<span>agent <b>' + esc(b.agent) + '</b></span>' +
        '<span>目录 <b title="' + esc(b.cwd) + '">' + esc(tail(b.cwd)) + '</b></span>' +
        '<span>模型 <b>' + esc(b.model || '默认') + '</b></span>' +
        '<span>会话 <b class="mono">' + esc(b.sessionId) + '</b></span>' +
      '</div>' +
      '<div class="card-actions">' +
        (canModel
          ? '<button class="btn" data-act="model" data-chat="' + esc(b.chatId) + '">换模型</button>'
          : '<span class="dim" style="font-size:12px">模型由 ' + esc(b.agent) + ' 自己管</span>') +
        '<button class="btn" data-act="agent" data-chat="' + esc(b.chatId) + '">换 agent</button>' +
        (live ? '<button class="btn" data-act="release" data-session="' + esc(b.sessionId) + '">重启会话</button>' : '') +
        '<span class="spacer" style="flex:1"></span>' +
        '<button class="btn danger" data-act="unbind" data-chat="' + esc(b.chatId) + '" ' +
          'data-name="' + esc(name) + '">断开</button>' +
      '</div>' +
    '</div>';
  }).join('');
  return '<div class="cards">' + cards + '</div>' +
    '<div style="margin-top:14px"><button class="btn primary" data-act="wizard">+ 连接新的群</button></div>';
}

/* ══════════════ 向导：一步一个决定 ══════════════ */

/** 会话这步排在目录和 agent 之后 —— 有哪些会话可接管取决于这两个 */
var STEPS = ['选群', '选目录', '选 agent', '选会话', '谁能用'];

function openWizard() {
  wiz = {
    step: 0, chatId: '', chatName: '', cwd: '', dirs: [], parent: null,
    dirInput: '', dirError: '', dirLoading: false,
    agent: 'pi', model: '', owner: '', members: [], q: '',
    // sessionId 为空 = 新建；resume=true 表示接管已有会话
    sessionId: '', resume: false, sessions: null
  };
  loadDirs('');
  render();
}

function closeWizard() { wiz = null; render(); }

function loadDirs(path) {
  wiz.dirLoading = true;
  wiz.dirError = '';
  render();
  return getJSON('/api/fs' + (path ? '?path=' + encodeURIComponent(path) : ''))
    .then(function (d) {
      if (!wiz) return;
      if (d && d.error) {
        /* 手输的路径打不开：保留原样让用户改，不要跳回旧目录假装成功 */
        wiz.dirError = d.error.message || '打不开这个目录';
        return;
      }
      wiz.cwd = d.path;
      wiz.dirs = d.dirs || [];
      wiz.parent = d.parent || null;
      wiz.dirInput = '';
    })
    .then(function () {
      if (!wiz) return;
      wiz.dirLoading = false;
      render();
      /* 跳转失败时把焦戻回地址栏（render 会把 input 重建），方便改错 */
      var el = document.getElementById('w-cwd');
      if (el && wiz.dirError) el.focus();
    });
}

/** 地址栏跳转：支持 ~/、相对路径、结尾多余的 / */
function gotoDir() {
  var el = document.getElementById('w-cwd');
  var v = el && el.value ? el.value.trim() : '';
  if (!v) return;
  wiz.dirInput = v;
  return loadDirs(v);
}

function loadMembers() {
  if (!wiz || !wiz.chatId) return Promise.resolve();
  return getJSON('/api/members?chatId=' + encodeURIComponent(wiz.chatId)).then(function (list) {
    if (!wiz) return;
    wiz.members = list || [];
    render();
  });
}

function loadModels(agent) {
  if (modelsCache[agent]) { render(); return Promise.resolve(modelsCache[agent]); }
  return getJSON('/api/models?agent=' + agent).then(function (list) {
    // 服务端是 {models:[...]}；兼容一下老版本返回裸数组
    var arr = Array.isArray(list) ? list : (list && list.models) || [];
    modelsCache[agent] = arr;
    render();
    return arr;
  });
}

/** 该 cwd + agent 下已有的会话（可接管的）。null = 还在加载 */
function loadSessions() {
  if (!wiz) return Promise.resolve();
  wiz.sessions = null;
  render();
  var want = wiz.agent + '|' + wiz.cwd;
  return getJSON('/api/sessions?agent=' + wiz.agent + '&cwd=' + encodeURIComponent(wiz.cwd))
    .then(function (list) {
      // 用户可能在请求飞行途中改了 agent/目录，结果就作废了
      if (!wiz || wiz.agent + '|' + wiz.cwd !== want) return;
      wiz.sessions = list || [];
      render();
    })
    .catch(function () {
      if (wiz) { wiz.sessions = []; render(); }
    });
}

function stepsBar() {
  return '<div class="steps">' + STEPS.map(function (s, i) {
    var cls = i === wiz.step ? 'now' : (i < wiz.step ? 'done' : '');
    return '<span class="' + cls + '">' + (i < wiz.step ? '✓ ' : '') + esc(s) + '</span>';
  }).join('') + '</div>';
}

function stepChat() {
  var bound = {};
  state.bindings.forEach(function (b) { bound[b.chatId] = b.sessionId; });
  var q = (wiz.q || '').toLowerCase();
  var list = state.chats.filter(function (c) {
    return !q || (c.name || '').toLowerCase().indexOf(q) >= 0 || c.chatId.toLowerCase().indexOf(q) >= 0;
  });
  var rows = list.map(function (c) {
    var taken = bound[c.chatId];
    return '<button class="pick" data-act="w-chat" data-id="' + esc(c.chatId) + '" ' +
      'data-name="' + esc(c.name || '') + '"' + (taken ? ' disabled' : '') +
      ' aria-selected="' + (wiz.chatId === c.chatId) + '">' +
      '<span class="grow"><div>' + esc(c.name || shortId(c.chatId)) + '</div>' +
      '<div class="sub mono">' + esc(c.chatId) + (taken ? ' · 已连到 ' + esc(taken) : '') + '</div></span>' +
      (wiz.chatId === c.chatId ? '<span class="tick">✓</span>' : '') +
    '</button>';
  }).join('');
  return '<div class="field"><label for="w-q">找群</label>' +
    '<input type="text" id="w-q" placeholder="输入群名或 ID 过滤" value="' + esc(wiz.q || '') + '"></div>' +
    (rows ? '<div class="picker">' + rows + '</div>'
          : '<div class="empty" style="padding:28px"><p>' +
            (state.chats.length ? '没有匹配的群' : '机器人还不在任何群里，先把它拉进群') +
            '</p><button class="btn" data-act="refresh-chats">刷新群列表</button></div>') +
    '<div class="hint" style="margin-top:8px;font-size:11.5px;color:var(--dim-2)">' +
      '灰掉的群已经连到别的会话了。一个群同时只能属于一条会话。</div>';
}

function stepDir() {
  var crumbs = '<div class="crumb"><span>当前</span><b class="mono">' + esc(wiz.cwd) + '</b>' +
    (wiz.parent ? ' <button data-act="w-up">↑ 上一级</button>' : '') + '</div>';
  var bar =
    '<div class="field"><label for="w-cwd">路径</label>' +
      '<div class="row" style="gap:6px">' +
        '<input id="w-cwd" class="mono grow" type="text" spellcheck="false" ' +
          'autocomplete="off" aria-label="目录路径（可直接输入，支持 ~/）" ' +
          'value="' + esc(wiz.dirError ? wiz.dirInput : wiz.cwd) + '">' +
        '<button class="btn" type="button" data-act="w-goto"' + (wiz.dirLoading ? ' disabled' : '') + '>跳转</button>' +
      '</div>' +
      (wiz.dirLoading
        ? '<div class="hint">打开中…</div>'
        : wiz.dirError
          ? '<div class="hint" style="color:var(--danger,#e5484d)">' + esc(wiz.dirError) + '</div>'
          : '<div class="hint">直接输路径回车即可跳转（相对 $HOME，支持 <code>~</code>）。</div>') +
    '</div>';
  var recent = (state.recentCwds || []).filter(function (p) { return p !== wiz.cwd; });
  var recentHtml = recent.length
    ? '<div class="field"><label>最近用过</label>' + recent.map(function (p) {
        return '<button class="btn" style="margin:0 6px 6px 0" data-act="w-cd" data-path="' +
          esc(p) + '">' + esc(p) + '</button>';
      }).join('') + '</div>'
    : '';
  var rows = wiz.dirs.map(function (d) {
    return '<button class="pick" data-act="w-cd" data-path="' + esc(d.path) + '">' +
      '<span class="dim">📁</span><span class="grow">' + esc(d.name) + '</span>' +
      '<span class="dim" style="font-size:11px">进入</span></button>';
  }).join('');
  return recentHtml + bar + crumbs +
    (rows ? '<div class="picker">' + rows + '</div>'
          : '<div class="dim" style="padding:14px 0;font-size:12.5px">这个目录下没有子目录</div>') +
    '<div class="hint" style="margin-top:10px;font-size:11.5px;color:var(--dim-2)">' +
      'agent 会在<b class="mono"> ' + esc(wiz.cwd) + ' </b>里干活。点「下一步」用当前目录。</div>';
}

function stepAgent() {
  var agents = [
    { id: 'pi', name: 'pi', desc: '本地 pi 会话' },
    { id: 'claude', name: 'Claude Code', desc: '一轮一进程，--resume 续接' },
    { id: 'codex', name: 'Codex CLI', desc: '受沙箱设置约束' }
  ];
  var rows = agents.map(function (a) {
    return '<button class="pick" data-act="w-agent" data-id="' + a.id + '" aria-selected="' +
      (wiz.agent === a.id) + '"><span class="grow"><div>' + esc(a.name) + '</div>' +
      '<div class="sub">' + esc(a.desc) + '</div></span>' +
      (wiz.agent === a.id ? '<span class="tick">✓</span>' : '') + '</button>';
  }).join('');
  var models = modelsCache[wiz.agent];
  var modelField;
  if (models === undefined) {
    modelField = '<div class="dim" style="font-size:12.5px"><span class="spin"></span> 正在读可用模型…</div>';
  } else if (!models.length) {
    modelField = '<input type="text" id="w-model" placeholder="provider/model（留空用 agent 默认）" value="' +
      esc(wiz.model) + '"><div class="hint">这个 agent 没提供模型列表，可直接填，填错由 agent 自己报错。</div>';
  } else {
    modelField = '<select id="w-model"><option value="">（用 agent 默认）</option>' +
      models.map(function (m) {
        var v = (m.provider ? m.provider + '/' : '') + m.id;
        return '<option value="' + esc(v) + '"' + (wiz.model === v ? ' selected' : '') + '>' + esc(v) + '</option>';
      }).join('') + '</select>';
  }
  return '<div class="picker" style="margin-bottom:14px">' + rows + '</div>' +
    '<div class="field"><label for="w-model">模型</label>' + modelField + '</div>';
}

function stepSession() {
  var newRow = '<button class="pick" data-act="w-session" data-id="" aria-selected="' +
    (!wiz.resume) + '"><span class="grow"><div>＋ 在这个目录下开一条新会话</div>' +
    '<div class="sub">空白上下文 · ' + esc(wiz.cwd) + ' · ID 自动生成</div></span>' +
    (!wiz.resume ? '<span class="tick">✓</span>' : '') + '</button>';

  if (wiz.sessions === null) {
    return '<div class="picker">' + newRow + '</div>' +
      '<div class="dim" style="margin-top:12px;font-size:12.5px">' +
      '<span class="spin"></span> 正在找 ' + esc(wiz.cwd) + ' 下已有的 ' + esc(wiz.agent) + ' 会话…</div>';
  }

  var rows = wiz.sessions.map(function (s) {
    var sel = wiz.resume && wiz.sessionId === s.sessionId;
    return '<button class="pick" data-act="w-session" data-id="' + esc(s.sessionId) + '" ' +
      'aria-selected="' + sel + '"><span class="grow"><div class="mono">' + esc(s.sessionId) + '</div>' +
      '<div class="sub">最后活动 ' + esc(new Date(s.mtime).toLocaleString()) + '</div></span>' +
      (sel ? '<span class="tick">✓</span>' : '') + '</button>';
  }).join('');

  var note = wiz.sessions.length
    ? '接管已有会话 = 群里 @机器人 就是接着这条会话继续说，它记得之前的上下文。'
    : '这个目录下没有找到已有的 ' + wiz.agent + ' 会话' +
      (wiz.agent === 'codex' ? '（codex 按 rollout 首行的 cwd 匹配，只看最近 200 条）' : '') + '。';

  return '<div class="picker">' + newRow + rows + '</div>' +
    '<div class="hint" style="margin-top:10px;font-size:11.5px;color:var(--dim-2)">' + esc(note) + '</div>';
}

function stepOwner() {
  var rows = [
    '<button class="pick" data-act="w-owner" data-id="*" aria-selected="' + (wiz.owner === '*') + '">' +
      '<span class="grow"><div>群里所有人</div><div class="sub">任何人 @机器人 都能驱动这条会话</div></span>' +
      (wiz.owner === '*' ? '<span class="tick">✓</span>' : '') + '</button>'
  ];
  wiz.members.forEach(function (m) {
    rows.push('<button class="pick" data-act="w-owner" data-id="' + esc(m.id) + '" aria-selected="' +
      (wiz.owner === m.id) + '"><span class="grow"><div>只有 ' + esc(m.name) + '</div>' +
      '<div class="sub mono">' + esc(shortId(m.id)) + '</div></span>' +
      (wiz.owner === m.id ? '<span class="tick">✓</span>' : '') + '</button>');
  });
  var summary = '<fieldset style="margin-top:16px"><legend>确认</legend>' +
    '<div class="meta" style="margin:0;display:grid;gap:6px">' +
      '<span>群 <b>' + esc(wiz.chatName || shortId(wiz.chatId)) + '</b></span>' +
      '<span>目录 <b class="mono">' + esc(wiz.cwd) + '</b></span>' +
      '<span>agent <b>' + esc(wiz.agent) + '</b>' + (wiz.model ? ' · 模型 <b>' + esc(wiz.model) + '</b>' : '') + '</span>' +
      '<span>会话 ' + (wiz.resume
        ? '<b class="mono">' + esc(wiz.sessionId) + '</b> <span class="ok">（接管已有，保留上下文）</span>'
        : '<b>新建</b>') + '</span>' +
    '</div></fieldset>';
  return '<div class="picker">' + rows.join('') + '</div>' +
    (wiz.members.length ? '' : '<div class="hint" style="margin-top:8px;font-size:11.5px;color:var(--dim-2)">' +
      '拿不到群成员列表（可能缺权限），可以先选「群里所有人」。</div>') +
    summary;
}

function renderWizard() {
  var body = wiz.step === 0 ? stepChat() : wiz.step === 1 ? stepDir()
    : wiz.step === 2 ? stepAgent() : wiz.step === 3 ? stepSession() : stepOwner();
  // 选群必须选中；选会话时还在加载就先别放行；最后一步要选 owner
  var canNext = wiz.step === 0 ? Boolean(wiz.chatId)
    : wiz.step === 3 ? wiz.sessions !== null
    : wiz.step === 4 ? Boolean(wiz.owner)
    : true;
  var lastStep = wiz.step === STEPS.length - 1;
  return '<div class="card">' + stepsBar() + body +
    '<div class="wizard-foot">' +
      '<button class="btn" data-act="w-cancel">取消</button>' +
      '<div style="display:flex;gap:9px">' +
        (wiz.step > 0 ? '<button class="btn" data-act="w-back">上一步</button>' : '') +
        '<button class="btn primary" data-act="' + (lastStep ? 'w-submit' : 'w-next') + '"' +
          (canNext ? '' : ' disabled') + '>' + (lastStep ? '连接' : '下一步') + '</button>' +
      '</div>' +
    '</div></div>';
}

/* ══════════════ 运维 tab ══════════════ */

function tableOr(empty, head, rows) {
  return rows
    ? '<div class="tablewrap"><table><thead><tr>' + head + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
    : '<div class="dim" style="padding:16px 0;font-size:12.5px">' + empty + '</div>';
}

function renderSessions() {
  var rows = state.sessions.map(function (s) {
    return '<tr><td class="mono">' + esc(s.sessionId) + '</td>' +
      '<td>' + esc(s.agent) + '</td>' +
      '<td class="mono" title="' + esc(s.cwd) + '">' + esc(tail(s.cwd)) + '</td>' +
      '<td>空闲 ' + ago(s.idleMs) + '</td>' +
      '<td class="mono">' + esc(s.model || '默认') + '</td>' +
      '<td><button class="btn danger" data-act="release" data-session="' + esc(s.sessionId) + '">停止</button></td>' +
    '</tr>';
  }).join('');
  return '<div class="section"><h2>运行中的会话</h2>' +
    tableOr('没有会话在跑。群里 @机器人 会自动拉起。',
      '<th>会话</th><th>agent</th><th>目录</th><th>状态</th><th>模型</th><th><span class="sr-only">操作</span></th>',
      rows) + '</div>';
}

function renderCodes() {
  var rows = state.codes.map(function (c) {
    return '<tr><td class="mono" style="font-size:15px;letter-spacing:2px">' + esc(c.code) + '</td>' +
      '<td class="mono">' + esc(c.sessionId) + '</td>' +
      '<td>' + ago(c.expiresAt - state.now) + '后过期</td>' +
      '<td><button class="btn" data-act="code-del" data-code="' + esc(c.code) + '">作废</button></td></tr>';
  }).join('');
  return '<div class="section"><h2>绑定码</h2>' +
    tableOr('没有待用的绑定码。', '<th>码</th><th>会话</th><th>剩余</th><th><span class="sr-only">操作</span></th>', rows) +
    '</div>';
}

function renderQueue() {
  var q = state.queue;
  var rows = q.pendingOutbound.map(function (m) {
    return '<tr><td class="mono">' + esc(shortId(m.chatId)) + '</td>' +
      '<td>' + esc(String(m.text).slice(0, 60)) + '</td><td>' + m.attempts + ' 次</td>' +
      '<td><button class="btn danger" data-act="out-del" data-id="' + esc(m.id) + '">丢弃</button></td></tr>';
  }).join('');
  return '<div class="section"><h2>队列</h2>' +
    '<div class="meta" style="margin:0 0 10px"><span>待处理入站 <b>' + q.pendingInbound + '</b></span>' +
    '<span>待发出站 <b>' + q.pendingOutbound.length + '</b></span>' +
    (q.pendingOutbound.length ? '<button class="link" data-act="out-flush">立即重试</button>' : '') + '</div>' +
    tableOr('出站队列是空的。', '<th>群</th><th>内容</th><th>已试</th><th><span class="sr-only">操作</span></th>', rows) +
    '</div>';
}

function renderDoctor() {
  if (!state.doctor) {
    return '<div class="section"><h2>诊断</h2><button class="btn" data-act="doctor">开始体检</button></div>';
  }
  var items = (state.doctor.checks || []).map(function (c) {
    return '<div style="padding:7px 0;border-bottom:1px solid var(--line-soft)">' +
      (c.ok ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>') +
      ' <span class="mono">' + esc(c.id) + '</span> <span class="dim">' + esc(c.detail || '') + '</span>' +
      (!c.ok && c.hint ? '<div class="dim" style="margin-left:18px;font-size:12px">→ ' + esc(c.hint) + '</div>' : '') +
    '</div>';
  }).join('');
  return '<div class="section"><h2>诊断</h2>' + items +
    '<div style="margin-top:10px"><button class="btn" data-act="doctor">重新体检</button></div></div>';
}

function renderChats() {
  var rows = state.chats.map(function (c) {
    var b = state.bindings.filter(function (x) { return x.chatId === c.chatId; })[0];
    return '<tr><td>' + esc(c.name || '-') + '</td><td class="mono">' + esc(c.chatId) + '</td>' +
      '<td>' + (b ? '<span class="badge live">已连 ' + esc(b.sessionId) + '</span>' : '<span class="dim">未连接</span>') +
      '</td></tr>';
  }).join('');
  return '<div class="section"><h2>机器人所在的群 <button class="link" data-act="refresh-chats">刷新</button></h2>' +
    tableOr('机器人不在任何群里。', '<th>群名</th><th>ID</th><th>状态</th>', rows) + '</div>';
}

function renderSettings() {
  var st = state.settings || {};
  var dm = state.defaultModels || {};
  var defRows = ['pi', 'claude', 'codex'].map(function (a) {
    var models = modelsCache[a];
    var ctrl;
    if (models && models.length) {
      ctrl = '<select id="dm-' + a + '"><option value="">（不设）</option>' + models.map(function (m) {
        var v = (m.provider ? m.provider + '/' : '') + m.id;
        return '<option value="' + esc(v) + '"' + (dm[a] === v ? ' selected' : '') + '>' + esc(v) + '</option>';
      }).join('') + '</select>';
    } else {
      ctrl = '<input type="text" id="dm-' + a + '" value="' + esc(dm[a] || '') + '" placeholder="provider/model">';
    }
    return '<div class="field"><label for="dm-' + a + '">' + a + '</label>' + ctrl + '</div>';
  }).join('');
  return '<div class="section"><h2>设置</h2>' +
    '<fieldset><legend>每个 agent 的默认模型</legend><div class="inline">' + defRows + '</div>' +
      '<div style="margin-top:12px"><button class="btn" data-act="save-defaults">保存默认模型</button></div>' +
    '</fieldset>' +
    '<fieldset><legend>历史回填</legend><div class="inline">' +
      '<div class="field"><label for="s-boot">首次连接时注入群历史</label><select id="s-boot">' +
        '<option value="true"' + (st.bootstrapEnabled !== false ? ' selected' : '') + '>开</option>' +
        '<option value="false"' + (st.bootstrapEnabled === false ? ' selected' : '') + '>关</option>' +
      '</select></div>' +
      '<div class="field"><label for="s-bmax">最多几条</label>' +
        '<input type="number" id="s-bmax" min="1" max="200" value="' + esc(st.bootstrapMaxMessages) + '"></div>' +
      '<div class="field"><label for="s-bdays">最多几天内</label>' +
        '<input type="number" id="s-bdays" min="1" max="90" value="' + esc(st.bootstrapMaxAgeDays) + '"></div>' +
    '</div><div class="hint" style="font-size:11.5px;color:var(--dim-2);margin-top:8px">' +
      '每个群只回填一次，改这里只影响之后新连的群。</div></fieldset>' +
    '<fieldset><legend>旁观消息</legend><div class="inline">' +
      '<div class="field"><label for="s-pw">没 @ 机器人时最多攒几条作上下文</label>' +
        '<input type="number" id="s-pw" min="1" max="200" value="' + esc(st.pendingWindowMax) + '"></div>' +
    '</div></fieldset>' +
    '<fieldset><legend>Codex 沙箱</legend><div class="field"><label for="s-sandbox">权限档位</label>' +
      '<select id="s-sandbox">' +
        '<option value=""' + (!st.codexSandboxMode ? ' selected' : '') + '>跟随 codex 自己的 config.toml</option>' +
        '<option value="read-only"' + (st.codexSandboxMode === 'read-only' ? ' selected' : '') + '>只读</option>' +
        '<option value="workspace-write"' + (st.codexSandboxMode === 'workspace-write' ? ' selected' : '') + '>可写工作区</option>' +
        '<option value="danger-full-access"' + (st.codexSandboxMode === 'danger-full-access' ? ' selected' : '') + '>完全访问（危险）</option>' +
      '</select><div class="hint">下一轮 codex 调用生效。</div></div></fieldset>' +
    '<fieldset><legend>让 agent 自己发文件</legend>' +
      '<div class="field"><label class="row" for="s-chat-tools">' +
        '<input type="checkbox" id="s-chat-tools"' + (st.chatToolsEnabled ? ' checked' : '') + '>' +
        '<span>允许 agent 把文件发到对话方（写一行 <code>MEDIA:&lt;路径&gt;</code>）</span></label>' +
        '<div class="hint">开了之后 agent 只需要在回复里单独写一行 <code>MEDIA:相对当前工作目录的路径</code>，'
        + 'instead 会自己上传并以机器人身份发出（不让它拼 lark-cli 命令，也不用知道 chat_id）。' +
        '文字回复仍然由 instead 自动送达，注入的说明里明确要求它不要重复发送。<br>' +
        '默认关闭：把「你在群里」这件事告诉 agent，它有时会顺手调 lark-cli 回消息，' +
        '导致群里收到两条重复。只在确实需要 agent 发文件时开。</div></div></fieldset>' +
    '<button class="btn primary" data-act="save-settings">保存设置</button></div>';
}

/* ══════════════ 总渲染 ══════════════ */

function render() {
  if (!state) return;
  var up = Boolean(state.daemon && state.daemon.pid);
  patch('daemon',
    '<span class="status ' + (up ? 'up' : 'down') + '"><span class="dot"></span>' +
    (up ? 'daemon 运行中' : 'daemon 未运行') + '</span>');

  var tabs = [
    { id: 'connections', label: '连接', n: state.bindings.length },
    { id: 'sessions', label: '会话', n: state.sessions.length },
    { id: 'groups', label: '群', n: state.chats.length },
    { id: 'settings', label: '设置', n: null },
    { id: 'ops', label: '运维', n: state.queue.pendingOutbound.length || null }
  ];
  patch('tabs', tabs.map(function (t) {
    return '<button role="tab" aria-selected="' + (tab === t.id) + '" data-act="tab" data-tab="' + t.id + '">' +
      esc(t.label) + (t.n ? '<span class="count">' + t.n + '</span>' : '') + '</button>';
  }).join(''));

  var body;
  if (wiz) body = renderWizard();
  else if (tab === 'connections') body = renderConnections();
  else if (tab === 'sessions') body = renderSessions();
  else if (tab === 'groups') body = renderChats();
  else if (tab === 'settings') body = renderSettings();
  else body = renderCodes() + renderQueue() + renderDoctor();
  patch('view', body);
}

function refresh() {
  return fetch('/api/state').then(function (r) { return r.json(); }).then(function (s) {
    state = s;
    render();
  }).catch(function () {
    patch('daemon', '<span class="status down"><span class="dot"></span>连接断开</span>');
  });
}

/* ══════════════ 交互 ══════════════ */

document.addEventListener('click', function (ev) {
  var el = ev.target.closest('[data-act]');
  if (!el) return;
  var a = el.dataset.act;

  /* ---- tab / 向导导航 ---- */
  if (a === 'tab') { tab = el.dataset.tab; wiz = null; render(); return; }
  if (a === 'wizard') { openWizard(); return; }
  if (a === 'w-cancel') { closeWizard(); return; }
  if (a === 'w-back') { wiz.step--; render(); return; }
  if (a === 'w-next') {
    wiz.step++;
    if (wiz.step === 2) loadModels(wiz.agent);
    if (wiz.step === 3) loadSessions();
    if (wiz.step === 4) loadMembers();
    render();
    return;
  }
  if (a === 'w-chat') {
    wiz.chatId = el.dataset.id;
    wiz.chatName = el.dataset.name || '';
    render();
    return;
  }
  if (a === 'w-cd') { loadDirs(el.dataset.path); return; }
  if (a === 'w-goto') { gotoDir(); return; }
  if (a === 'w-up') { loadDirs(wiz.parent || '/'); return; }
  if (a === 'w-agent') {
    if (wiz.agent !== el.dataset.id) {
      wiz.agent = el.dataset.id;
      wiz.model = '';
      // 换了 agent，之前选的会话不再适用
      wiz.sessionId = '';
      wiz.resume = false;
      wiz.sessions = null;
    }
    loadModels(wiz.agent);
    render();
    return;
  }
  if (a === 'w-session') {
    var sid = el.dataset.id || '';
    wiz.sessionId = sid;
    wiz.resume = Boolean(sid);
    render();
    return;
  }
  if (a === 'w-owner') { wiz.owner = el.dataset.id; render(); return; }
  if (a === 'w-submit') {
    var m = document.getElementById('w-model');
    var model = m ? m.value.trim() : '';
    // 接管已有会话就用它的 id；否则生成一个新的逻辑 id
    var resume = wiz.resume && Boolean(wiz.sessionId);
    var sessionId = resume ? wiz.sessionId : 'is-' + Date.now().toString(36);
    var label = wiz.chatName || wiz.chatId;
    var payload = {
      chatId: wiz.chatId, sessionId: sessionId, agent: wiz.agent,
      cwd: wiz.cwd, ownerOpenId: wiz.owner,
      // 让 daemon 写 session_aliases —— opaque 语义的 adapter 只认别名，
      // 不写就会静默新建一条，用户选的会话被忽略
      resumeExisting: resume
    };
    act(function () {
      return api('POST', '/api/bind', payload).then(function () {
        if (model) return api('POST', '/api/model', { sessionId: sessionId, model: model });
      });
    }, resume ? '已接管会话 ' + sessionId : '已连接 ' + label).then(function () {
      wiz = null;
      tab = 'connections';
      render();
    }).catch(function () { /* 错误已 toast，留在向导让用户改 */ });
    return;
  }

  /* ---- 卡片操作 ---- */
  if (a === 'unbind') {
    confirmDlg('断开这个群？', '「' + el.dataset.name + '」之后 @机器人 不再有反应。会话历史留在本地不受影响，重新连接即可恢复。', '断开')
      .then(function (yes) {
        if (yes) act(function () { return api('POST', '/api/unbind', { chatId: el.dataset.chat }); }, '已断开');
      });
    return;
  }
  if (a === 'release') {
    confirmDlg('重启这条会话？', '当前 agent 进程会停掉，下次群里有人 @机器人 时自动重新拉起。', '重启')
      .then(function (yes) {
        if (yes) act(function () { return api('POST', '/api/session/release', { sessionId: el.dataset.session }); }, '会话已停止');
      });
    return;
  }
  if (a === 'model') { openModelDlg(el.dataset.chat); return; }
  if (a === 'agent') { openAgentDlg(el.dataset.chat); return; }

  /* ---- 运维 ---- */
  if (a === 'doctor') { act(function () { return api('POST', '/api/doctor/refresh', {}); }); return; }
  if (a === 'refresh-chats') { act(function () { return api('POST', '/api/chats/refresh', {}); }, '群列表已刷新'); return; }
  if (a === 'out-flush') { act(function () { return api('POST', '/api/outbound/flush', {}); }, '已触发重试'); return; }
  if (a === 'out-del') {
    act(function () { return api('POST', '/api/outbound/discard', { id: Number(el.dataset.id) }); }, '已丢弃');
    return;
  }
  if (a === 'code-del') {
    act(function () { return api('POST', '/api/code/delete', { code: el.dataset.code }); }, '已作废');
    return;
  }

  /* ---- 设置 ---- */
  if (a === 'save-defaults') {
    act(function () {
      var chain = Promise.resolve();
      ['pi', 'claude', 'codex'].forEach(function (ag) {
        var i = document.getElementById('dm-' + ag);
        if (!i) return;
        chain = chain.then(function () {
          return api('POST', '/api/default-model', { agent: ag, model: i.value.trim() });
        });
      });
      return chain;
    }, '默认模型已保存');
    return;
  }
  if (a === 'save-settings') {
    act(function () {
      var pairs = [
        ['bootstrap.enabled', 's-boot'], ['bootstrap.max_messages', 's-bmax'],
        ['bootstrap.max_age_days', 's-bdays'], ['pending_window.max_messages', 's-pw'],
        ['codex.sandbox_mode', 's-sandbox'], ['chat_tools.enabled', 's-chat-tools']
      ];
      var chain = Promise.resolve();
      pairs.forEach(function (p) {
        var i = document.getElementById(p[1]);
        if (!i) return;
        // checkbox 的 .value 恒为 'on'，得读 .checked，否则永远关不掉
        var v = i.type === 'checkbox' ? String(i.checked) : i.value;
        chain = chain.then(function () { return api('POST', '/api/settings', { key: p[0], value: v }); });
      });
      return chain;
    }, '设置已保存');
    return;
  }
});

/* 群过滤：本地过滤，不打服务端 */
document.addEventListener('keydown', function (ev) {
  /* 地址栏回车 = 跳转（没有 <form>，不然会把整个页面提交掉） */
  if (ev.key === 'Enter' && ev.target && ev.target.id === 'w-cwd') {
    ev.preventDefault();
    gotoDir();
  }
});

document.addEventListener('input', function (ev) {
  if (ev.target.id === 'w-q' && wiz) {
    wiz.q = ev.target.value;
    // 只换列表容器的内容，不重绘整个 view —— 重绘会连输入框一起换掉，
    // 光标位置就丢了（用户打第二个字时会跳到末尾）。
    var picker = document.querySelector('#view .picker');
    if (!picker) { lastHtml['view'] = null; render(); return; }
    var fresh = document.createElement('div');
    fresh.innerHTML = stepChat();
    var next = fresh.querySelector('.picker');
    picker.innerHTML = next ? next.innerHTML : '';
    lastHtml['view'] = null; // 让下一次真正 render 时不被差量跳过
  }
});

/* 轮询：输入中暂停，避免打断 */
var timer = null;
function startPoll() { if (!timer) timer = setInterval(refresh, 2000); }
function stopPoll() { if (timer) { clearInterval(timer); timer = null; } }
document.addEventListener('focusin', function (ev) {
  if (ev.target.matches('input,select')) stopPoll();
});
document.addEventListener('focusout', function (ev) {
  if (ev.target.matches('input,select')) setTimeout(startPoll, 150);
});

/* ══════════════ 通用选择对话框 ══════════════ */

/**
 * 从一组选项里挑一个。resolve(值) 或 resolve(null)=取消。
 * free=true 时额外给一个自由输入框（模型列表拿不到时用）。
 */
function openChoose(title, hint, options, current, free) {
  return new Promise(function (resolve) {
    var d = document.getElementById('choose');
    var picked = null;
    d.querySelector('.dlg-t').textContent = title;
    d.querySelector('#ch-hint').textContent = hint || '';
    d.querySelector('#ch-list').innerHTML = options.map(function (o) {
      return '<button class="pick" data-val="' + esc(o.value) + '" aria-selected="' +
        (o.value === current) + '"><span class="grow"><div>' + esc(o.label) + '</div>' +
        (o.sub ? '<div class="sub">' + esc(o.sub) + '</div>' : '') + '</span>' +
        (o.value === current ? '<span class="tick">✓</span>' : '') + '</button>';
    }).join('');
    var freeWrap = d.querySelector('#ch-free-wrap');
    var freeInput = d.querySelector('#ch-free');
    var saveBtn = d.querySelector('#ch-save');
    freeWrap.style.display = free ? 'block' : 'none';
    // 「保存」只服务于自由输入框。列表模式下点条目即生效，留着这个按钮会
    // 读到空输入框，把已选的模型静默重置成默认。
    saveBtn.style.display = free ? '' : 'none';
    if (free) freeInput.value = current || '';
    d.querySelector('#ch-list').onclick = function (ev) {
      var b = ev.target.closest('[data-val]');
      if (!b) return;
      picked = b.dataset.val;
      d.close('pick');
    };
    saveBtn.onclick = function () {
      picked = freeInput.value.trim();
      d.close('pick');
    };
    d.onclose = function () { resolve(d.returnValue === 'pick' ? picked : null); };
    d.showModal();
  });
}

function bindingOf(chatId) {
  return state.bindings.filter(function (b) { return b.chatId === chatId; })[0];
}

/** 换 agent（决策 31）：换驱动者 = 新会话起步或接管该 agent 的已有会话；旧会话保留 */
var AGENT_OPTIONS = [
  { value: 'pi', label: 'pi', sub: '本机 pi（--mode rpc），运行时换模型、图片输入' },
  { value: 'claude', label: 'claude', sub: 'Claude Code CLI（一轮一进程，--resume 续跑）' },
  { value: 'codex', label: 'codex', sub: 'Codex CLI（thread id 学回后 resume）' },
];

function openAgentDlg(chatId) {
  var b = bindingOf(chatId);
  if (!b) return;
  var label = b.name || shortId(b.chatId);
  openChoose(
    '换 agent · ' + label,
    '换 agent = 本群改由另一个 agent 驱动。会话不能跨 agent 搬：默认开一条新会话（旧会话完整保留），也可以接管新 agent 在 ' + esc(tail(b.cwd)) + ' 下的已有会话。',
    AGENT_OPTIONS,
    b.agent,
    false,
  ).then(function (agent) {
    if (agent === null) return;
    getJSON('/api/sessions?agent=' + agent + '&cwd=' + encodeURIComponent(b.cwd))
      .then(function (list) {
        var opts = [{ value: '', label: '+ 新建会话（空白，旧会话保留）' }].concat(
          (list || []).map(function (s) {
            return {
              value: s.sessionId,
              label: s.sessionId,
              sub: '最后活动 ' + new Date(s.mtime).toLocaleString(),
            };
          }),
        );
        openChoose(
          '接管哪条 ' + agent + ' 会话？',
          '选「新建」= 从零开始；选已有会话 = 群里接着它继续说（记得之前的上下文）。',
          opts,
          '',
          false,
        ).then(function (sid) {
          if (sid === null) return;
          act(
            function () {
              return api('POST', '/api/switch-agent', {
                chatId: chatId,
                agent: agent,
                sessionId: sid || '',
                resumeExisting: Boolean(sid),
              });
            },
            function (r) {
              var newSid = r && r.binding ? r.binding.sessionId : sid || '';
              return sid
                ? '已切到 ' + agent + ' · 接管会话 ' + newSid
                : '已切到 ' + agent + ' · 新会话 ' + newSid + '（旧会话原样保留）';
            },
          );
        });
      })
      .catch(function (e) {
        toast(e.message || String(e), 'error');
      });
  });
}

function openModelDlg(chatId) {
  var b = bindingOf(chatId);
  if (!b) return;
  var label = b.name || shortId(b.chatId);
  loadModels(b.agent).then(function (list) {
    var hasList = Boolean(list && list.length);
    var opts = [{ value: '', label: '（用 ' + b.agent + ' 的默认模型）' }].concat(
      (list || []).map(function (m) {
        var v = (m.provider ? m.provider + '/' : '') + m.id;
        return { value: v, label: v };
      })
    );
    var live = sessionOf(b.chatId);
    var hint = hasList
      ? (live && live.capabilities.modelSwitch === 'runtime'
          ? '会话在线，切换立即生效。'
          : live
            ? '切换后要重启 agent 进程，下一轮生效。'
            : '会话空闲，保存后下次启动生效。')
      : b.agent + ' 没提供模型列表，直接填 provider/model；填错由 agent 自己报错。';
    openChoose('换模型 · ' + label, hint, opts, b.model || '', !hasList).then(function (v) {
      if (v === null) return;
      act(
        function () {
          return api('POST', '/api/model', { sessionId: b.sessionId, model: v });
        },
        function (r) {
          if (!v) return '已改回 agent 默认模型';
          return r && r.applied === 'runtime'
            ? '模型已切换：' + v + '（立即生效）'
            : '模型已保存：' + v + '（下次启动会话生效）';
        },
      );
    });
  });
}

refresh();
startPoll();
`;

export function renderPage(opts: PageOptions): string {
  const { csrf, nonce } = opts;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Instead · 配置台</title>
<style nonce="${nonce}">${CSS}</style>
</head>
<body data-csrf="${csrf}">
<header>
  <div class="logo" aria-hidden="true">◈</div>
  <h1>Instead</h1>
  <div class="spacer"></div>
  <div id="daemon"></div>
</header>

<nav id="tabs" role="tablist" aria-label="配置台分区"></nav>

<main>
  <div id="view"></div>
</main>

<div id="toasts" class="toasts" role="status" aria-live="polite"></div>
<div id="saving" role="status" aria-live="polite"><span class="spin"></span>处理中…</div>

<dialog id="confirm">
  <div class="dlg-t"></div>
  <div class="dlg-b"></div>
  <div class="dlg-f">
    <button class="btn" id="c-no" data-close="confirm">取消</button>
    <button class="btn primary" id="c-yes" data-close="confirm" data-val="yes">确定</button>
  </div>
</dialog>

<dialog id="choose">
  <div class="dlg-t"></div>
  <div class="dlg-b">
    <div id="ch-hint" style="margin-bottom:12px"></div>
    <div id="ch-list" class="picker"></div>
    <div id="ch-free-wrap" style="display:none;margin-top:12px">
      <label for="ch-free">自己填</label>
      <input type="text" id="ch-free" placeholder="provider/model">
    </div>
  </div>
  <div class="dlg-f">
    <button class="btn" data-close="choose">取消</button>
    <button class="btn primary" id="ch-save">保存</button>
  </div>
</dialog>

<script nonce="${nonce}">
document.addEventListener('click', function (ev) {
  var b = ev.target.closest('[data-close]');
  if (b) document.getElementById(b.dataset.close).close(b.dataset.val || 'no');
});
${CLIENT_JS}
</script>
</body>
</html>`;
}

