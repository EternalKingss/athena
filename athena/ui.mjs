// ui.mjs — browser UI server, SSE broadcast, HTML template
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { NAME, MODEL, CURATED_MODELS, state } from './config.mjs';
import { PATHS } from './paths.mjs';
import { systemPrompt } from './personality.mjs';
import { turn, runTask, setRequestUserInput } from './core.mjs';
import { saveAndSummarize } from './memory.mjs';

const execAsync = promisify(exec);

// ---- SSE broadcast ----
export const sseClients = new Set();

export function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch { sseClients.delete(res); }
  }
}

export function uiEmit(event) { broadcast(event); }

// ---- Free port finder ----
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// ---- HTML template ----
function buildHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${NAME}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#080808;--surface:#0f0f0f;--surface2:#141414;--border:#1e1e1e;
  --text:#d4d4d4;--dim:#444;--dim2:#666;
  --green:#00ff88;--green-dim:#00cc6a;--green-glow:rgba(0,255,136,.12);
  --red:#ff4455;--red-dim:#cc2233;--red-glow:rgba(255,68,85,.12);
  --yellow:#fbbf24;--blue:#60a5fa;--accent:#00ff88;--accent2:#00cc6a;
}
html,body{height:100%;background:var(--bg);color:var(--text);font-family:'SF Mono','Fira Code','Cascadia Code',Consolas,monospace;font-size:13px;line-height:1.6}

/* subtle scanline overlay for that terminal feel */
body::after{content:'';position:fixed;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,.03) 2px,rgba(0,0,0,.03) 4px);pointer-events:none;z-index:9999}

#app{display:flex;flex-direction:column;height:100vh;max-width:920px;margin:0 auto}

/* header */
#header{display:flex;align-items:center;gap:12px;padding:12px 20px;border-bottom:1px solid var(--border);flex-shrink:0;background:var(--surface)}
#logo{font-size:15px;font-weight:700;letter-spacing:.12em;color:var(--green);text-shadow:0 0 12px rgba(0,255,136,.4);text-transform:uppercase}
#logo-sub{font-size:10px;color:var(--dim2);letter-spacing:.06em;margin-left:2px;align-self:flex-end;margin-bottom:1px}
#meta{color:var(--dim2);font-size:11px;flex:1}
#mem-btn,#clear-btn{background:none;border:1px solid var(--border);color:var(--dim2);padding:4px 10px;border-radius:3px;cursor:pointer;font-family:inherit;font-size:11px;letter-spacing:.04em;transition:all .15s}
#mem-btn:hover{border-color:var(--green);color:var(--green);box-shadow:0 0 8px var(--green-glow)}
#clear-btn:hover{border-color:var(--red);color:var(--red);box-shadow:0 0 8px var(--red-glow)}
#model-select{background:var(--surface);border:1px solid var(--border);color:var(--dim2);padding:3px 6px;border-radius:3px;font-family:inherit;font-size:11px;cursor:pointer;outline:none;transition:all .15s;max-width:180px}
#model-select:hover,#model-select:focus{border-color:var(--green);color:var(--green)}
#status-dot{width:8px;height:8px;border-radius:50%;background:var(--green);flex-shrink:0;transition:background .3s;box-shadow:0 0 6px var(--green)}
#status-dot.thinking{background:var(--yellow);box-shadow:0 0 6px var(--yellow);animation:pulse 1s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}

/* messages */
#messages{flex:1;overflow-y:auto;padding:24px 20px;display:flex;flex-direction:column;gap:14px;scroll-behavior:smooth}
#messages::-webkit-scrollbar{width:3px}
#messages::-webkit-scrollbar-track{background:transparent}
#messages::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}

.msg{display:flex;flex-direction:column;gap:3px;max-width:82%}
.msg.user{align-self:flex-end;align-items:flex-end}
.msg.assistant{align-self:flex-start}
.msg.system,.msg.sys{align-self:center;max-width:100%}

.bubble{padding:10px 15px;border-radius:8px;white-space:pre-wrap;word-break:break-word;line-height:1.65}

/* USER = red */
.msg.user .bubble{
  background:var(--red-glow);
  color:var(--red);
  border:1px solid var(--red-dim);
  border-bottom-right-radius:2px;
  text-shadow:0 0 8px rgba(255,68,85,.2);
}

/* ATHENA = green */
.msg.assistant .bubble{
  background:var(--green-glow);
  color:var(--green);
  border:1px solid rgba(0,255,136,.2);
  border-bottom-left-radius:2px;
  text-shadow:0 0 8px rgba(0,255,136,.15);
}

.msg.system .bubble,.msg.sys .bubble{background:transparent;color:var(--dim2);font-size:11px;text-align:center;border:none;padding:4px;letter-spacing:.04em}

.label{font-size:10px;color:var(--dim);margin:0 3px;letter-spacing:.06em;text-transform:uppercase}
.msg.user .label{color:var(--red-dim)}
.msg.assistant .label{color:var(--green-dim)}

/* tool block */
.tools-block{background:var(--surface);border:1px solid var(--border);border-radius:6px;overflow:hidden;font-size:12px;align-self:flex-start;max-width:82%}
.tools-block:hover{border-color:#2a2a2a}
.tools-header{display:flex;align-items:center;gap:8px;padding:7px 12px;cursor:pointer;user-select:none;color:var(--dim2)}
.tools-header:hover{color:var(--text)}
.tools-header svg{flex-shrink:0;transition:transform .2s}
.tools-header.open svg{transform:rotate(90deg)}
.tools-list{padding:0 12px 10px;display:flex;flex-direction:column;gap:6px}
.tool-item{display:flex;flex-direction:column;gap:2px}
.tool-cmd{color:var(--accent2);font-family:inherit}
.tool-result{color:var(--dim2);font-size:11px;white-space:pre-wrap;word-break:break-word;max-height:120px;overflow-y:auto}
.plan-block{align-self:flex-start;max-width:82%;background:var(--surface);border:1px solid rgba(0,255,136,.25);border-radius:6px;padding:10px 14px}
.plan-label{font-size:10px;color:var(--green-dim);margin-bottom:6px;letter-spacing:.1em;text-transform:uppercase}
.plan-content{white-space:pre-wrap;color:var(--green)}
#todo-strip{display:flex;gap:8px;padding:6px 20px;border-bottom:1px solid var(--border);min-height:32px;flex-wrap:wrap;align-items:center;flex-shrink:0;background:var(--surface)}
#todo-label{color:var(--dim);font-size:10px;letter-spacing:.1em;margin-right:4px;text-transform:uppercase}
.t-item{display:flex;align-items:center;gap:5px;font-size:11px;padding:2px 8px;border-radius:3px;border:1px solid var(--border)}
.t-item.pending{color:var(--dim2)}
.t-item.in_progress{color:var(--yellow);border-color:rgba(251,191,36,.4)}
.t-item.completed{color:var(--green-dim);border-color:rgba(0,255,136,.2);opacity:.5}
.t-item.cancelled{color:var(--red);opacity:.4;text-decoration:line-through}
.t-dot{width:5px;height:5px;border-radius:50%;background:currentColor}
.clarify-wrap{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.clarify-btn{background:transparent;border:1px solid rgba(0,255,136,.3);color:var(--green);padding:5px 12px;border-radius:4px;cursor:pointer;font-family:inherit;font-size:12px;letter-spacing:.04em;transition:all .15s}
.clarify-btn:hover{border-color:var(--green);background:var(--green-glow);box-shadow:0 0 8px var(--green-glow)}
#input-area{display:flex;gap:8px;padding:14px 20px;border-top:1px solid var(--border);flex-shrink:0;background:var(--surface)}
#input-wrap{flex:1;position:relative;display:flex;align-items:center}
#input-prefix{position:absolute;left:12px;color:var(--red);font-size:13px;pointer-events:none;user-select:none}
#input{flex:1;background:var(--bg);border:1px solid var(--red-dim);color:var(--red);padding:10px 14px 10px 28px;border-radius:6px;font-family:inherit;font-size:13px;resize:none;outline:none;transition:all .15s;min-height:42px;max-height:160px;caret-color:var(--red)}
#input::placeholder{color:rgba(255,68,85,.3)}
#input:focus{border-color:var(--red);box-shadow:0 0 10px var(--red-glow)}
#send{background:transparent;border:1px solid var(--green-dim);color:var(--green);padding:10px 18px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:12px;font-weight:700;letter-spacing:.08em;transition:all .15s;align-self:flex-end;text-transform:uppercase}
#send:hover{background:var(--green-glow);box-shadow:0 0 10px var(--green-glow)}
#send:disabled{opacity:.3;cursor:default}
#mem-panel{position:fixed;right:0;top:0;height:100%;width:320px;background:var(--surface);border-left:1px solid var(--border);display:flex;flex-direction:column;transform:translateX(100%);transition:transform .25s;z-index:100}
#mem-panel.open{transform:translateX(0)}
#mem-panel-header{display:flex;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--border)}
#mem-panel-header h3{font-size:13px;color:var(--accent2)}
#close-mem{background:none;border:none;color:var(--dim2);cursor:pointer;font-size:18px}
#mem-content{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.mem-item{background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px}
.mem-type{font-size:10px;color:var(--dim);margin-bottom:3px;text-transform:uppercase;letter-spacing:.06em}
.mem-text{color:var(--text);font-size:12px;word-break:break-word}
.mem-date{font-size:10px;color:var(--dim);margin-top:3px}
.mem-empty{color:var(--dim2);text-align:center;padding:20px;font-size:12px}
</style>
</head>
<body>
<div id="app">
  <div id="header">
    <div id="status-dot"></div>
    <div id="logo">⚔ ${NAME}<span id="logo-sub">// goddess of wisdom</span></div>
    <div id="meta"><select id="model-select" title="Switch model"><option>${MODEL}</option></select></div>
    <button id="clear-btn" onclick="clearCtx()">[ clear ]</button>
    <button id="mem-btn" onclick="openMem()">[ memory ]</button>
  </div>
  <div id="todo-strip"><span id="todo-label">tasks</span></div>
  <div id="messages"></div>
  <div id="input-area">
    <div id="input-wrap">
      <span id="input-prefix">&gt;</span>
      <textarea id="input" rows="1" placeholder="/task, /mem, /forget, /model …" onkeydown="onKey(event)" oninput="resize(this)"></textarea>
    </div>
    <button id="send" onclick="sendMsg()">Send →</button>
  </div>
</div>
<div id="mem-panel">
  <div id="mem-panel-header">
    <h3>Long-term memory</h3>
    <button id="close-mem" onclick="closeMem()">✕</button>
  </div>
  <div id="mem-content"><div class="mem-empty">Loading…</div></div>
</div>
<script>
const messages = document.getElementById('messages');
const input    = document.getElementById('input');
const sendBtn  = document.getElementById('send');
const dot      = document.getElementById('status-dot');

let currentTools = null;
let streamBubble = null;
let busy = false;

const modelSel = document.getElementById('model-select');
async function loadModels() {
  try {
    const r = await fetch('/models');
    const { groups, active } = await r.json();
    modelSel.innerHTML = '';
    let found = false;
    for (const group of groups) {
      const grp = document.createElement('optgroup');
      grp.label = group.label;
      for (const m of group.models) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m.includes('/') ? m.split('/')[1].replace(/-instruct.*$/, '') : m;
        opt.title = m;
        if (m === active) { opt.selected = true; found = true; }
        grp.appendChild(opt);
      }
      modelSel.appendChild(grp);
    }
    if (!found) {
      const opt = document.createElement('option');
      opt.value = active; opt.textContent = active; opt.selected = true;
      modelSel.prepend(opt);
    }
  } catch {}
}
modelSel.addEventListener('change', async () => {
  await fetch('/model', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({model: modelSel.value}) });
});
loadModels();

function setStatus(thinking) {
  busy = thinking;
  sendBtn.disabled = thinking;
  dot.className = thinking ? 'thinking' : '';
}
function scrollBottom() { messages.scrollTop = messages.scrollHeight; }
function addMsg(role, content) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = role === 'user' ? 'you' : role === 'plan' ? '' : '${NAME}';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = content;
  if (role !== 'plan') div.appendChild(label);
  div.appendChild(bubble);
  messages.appendChild(div);
  scrollBottom();
  return bubble;
}
function openToolBlock() {
  const block = document.createElement('div');
  block.className = 'tools-block';
  block.innerHTML = \`<div class="tools-header"><svg width="10" height="10" viewBox="0 0 10 10"><polygon points="2,1 8,5 2,9" fill="currentColor"/></svg><span>tools</span></div><div class="tools-list" style="display:none"></div>\`;
  block.querySelector('.tools-header').onclick = () => {
    const open = block.querySelector('.tools-list').style.display !== 'none';
    block.querySelector('.tools-list').style.display = open ? 'none' : 'flex';
    block.querySelector('.tools-header').classList.toggle('open', !open);
  };
  messages.appendChild(block);
  scrollBottom();
  return block;
}
function addToolItem(block, name, args, result) {
  const list = block.querySelector('.tools-list');
  list.style.display = 'flex';
  block.querySelector('.tools-header').classList.add('open');
  const item = document.createElement('div');
  item.className = 'tool-item';
  const cmd = document.createElement('div');
  cmd.className = 'tool-cmd';
  const icons = {run_shell:'$',web_search:'🔍',fetch_url:'🌐',read_file:'📄',write_file:'✏',edit_file:'✏',memory:'🧠',load_skill:'⚡',save_skill:'💾',update_skill:'💾',clipboard_read:'📋',clipboard_write:'📋',notify:'🔔',open:'🔗',list_dir:'📁'};
  const label = name === 'run_shell' ? (args.command||'').slice(0,80)
              : name === 'web_search' ? args.query
              : name === 'fetch_url' ? args.url
              : name === 'memory' ? \`\${args.action} [\${args.target}]\`
              : args.path || args.name || name;
  cmd.textContent = (icons[name]||'▸') + ' ' + label;
  item.appendChild(cmd);
  if (result) {
    const res = document.createElement('div');
    res.className = 'tool-result';
    res.textContent = String(result).slice(0, 300);
    item.appendChild(res);
  }
  list.appendChild(item);
  scrollBottom();
  return item;
}
const es = new EventSource('/events');
const pendingTools = {};
es.onmessage = e => {
  const ev = JSON.parse(e.data);
  if (ev.type === 'status') { setStatus(true); currentTools = null; streamBubble = null; }
  if (ev.type === 'stream_start') {
    currentTools = null;
    const wrap = document.createElement('div'); wrap.className = 'msg assistant';
    const lbl = document.createElement('div'); lbl.className = 'label'; lbl.textContent = '${NAME}';
    streamBubble = document.createElement('div'); streamBubble.className = 'bubble';
    wrap.appendChild(lbl); wrap.appendChild(streamBubble);
    messages.appendChild(wrap); scrollBottom();
  }
  if (ev.type === 'token') { if (streamBubble) { streamBubble.textContent += ev.content; scrollBottom(); } }
  if (ev.type === 'stream_end') { streamBubble = null; }
  if (ev.type === 'done') { setStatus(false); }
  if (ev.type === 'tool_start') {
    if (!currentTools) currentTools = openToolBlock();
    pendingTools[ev.name] = addToolItem(currentTools, ev.name, ev.args || {}, null);
  }
  if (ev.type === 'tool_result') {
    const item = pendingTools[ev.name];
    if (item) {
      let res = item.querySelector('.tool-result');
      if (!res) { res = document.createElement('div'); res.className = 'tool-result'; item.appendChild(res); }
      res.textContent = String(ev.result||'').slice(0, 300);
      delete pendingTools[ev.name];
    }
    scrollBottom();
  }
  if (ev.type === 'todo_update') {
    const strip = document.getElementById('todo-strip');
    strip.innerHTML = '<span id="todo-label">tasks</span>';
    for (const t of (ev.todos||[])) {
      const el = document.createElement('div'); el.className = \`t-item \${t.status}\`;
      const d = document.createElement('div'); d.className = 't-dot';
      el.appendChild(d); el.appendChild(document.createTextNode(t.content));
      strip.appendChild(el);
    }
  }
  if (ev.type === 'clarify') {
    currentTools = null;
    const wrap = document.createElement('div'); wrap.className = 'msg assistant';
    const lbl = document.createElement('div'); lbl.className = 'label'; lbl.textContent = '${NAME}';
    const bub = document.createElement('div'); bub.className = 'bubble';
    bub.textContent = ev.question;
    const choices = document.createElement('div'); choices.className = 'clarify-wrap';
    const all = [...(ev.choices||[]), 'Other…'];
    for (const c of all) {
      const btn = document.createElement('button'); btn.className = 'clarify-btn'; btn.textContent = c;
      btn.onclick = () => {
        choices.querySelectorAll('.clarify-btn').forEach(b => b.disabled = true);
        choices.style.opacity = '.4';
        input.value = c === 'Other…' ? '' : c;
        if (c !== 'Other…') sendMsg(); else input.focus();
      };
      choices.appendChild(btn);
    }
    bub.appendChild(choices);
    wrap.appendChild(lbl); wrap.appendChild(bub);
    messages.appendChild(wrap); scrollBottom();
    setStatus(false);
  }
  if (ev.type === 'system') {
    const wrap = document.createElement('div'); wrap.className = 'msg sys';
    const bub = document.createElement('div'); bub.className = 'bubble'; bub.textContent = ev.text;
    wrap.appendChild(bub); messages.appendChild(wrap); scrollBottom();
  }
  if (ev.type === 'model_changed') {
    for (const opt of modelSel.options) opt.selected = opt.value === ev.model;
  }
  if (ev.type === 'error') { setStatus(false); addMsg('system', '⚠ ' + ev.message); }
};
async function sendMsg() {
  const text = input.value.trim();
  if (!text || busy) return;
  addMsg('user', text);
  input.value = ''; resize(input); setStatus(true); currentTools = null;
  await fetch('/chat', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({text}) });
}
function onKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); } }
function resize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 160) + 'px'; }
function clearCtx() { fetch('/clear', {method:'POST'}); messages.innerHTML = ''; addMsg('system', 'Context cleared.'); }
async function openMem() {
  document.getElementById('mem-panel').classList.add('open');
  const r = await fetch('/memory');
  const data = await r.json();
  const el = document.getElementById('mem-content');
  if (!data.length) { el.innerHTML = '<div class="mem-empty">No memories yet.</div>'; return; }
  el.innerHTML = '';
  for (const m of data) {
    const item = document.createElement('div'); item.className = 'mem-item';
    item.innerHTML = \`<div class="mem-type">\${m.type||'note'}</div><div class="mem-text">\${m.content}</div>\`;
    el.appendChild(item);
  }
}
function closeMem() { document.getElementById('mem-panel').classList.remove('open'); }
addMsg('system', '${NAME} online.');
</script>
</body>
</html>`;
}

// ---- serveUI ----
export async function serveUI(messages) {
  const port = await getFreePort();
  process.env.ATHENA_UI = '1';

  let inputResolve = null;
  const inputQueue = [];
  function nextInput() {
    return new Promise(res => {
      if (inputQueue.length) { res(inputQueue.shift()); return; }
      inputResolve = res;
    });
  }
  function pushInput(text) {
    if (inputResolve) { inputResolve(text); inputResolve = null; }
    else inputQueue.push(text);
  }

  const HTML = buildHTML();

  const server = createServer(async (req, res) => {
    if (req.url === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML); return;
    }
    if (req.url === '/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
      res.write(':\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res)); return;
    }
    if (req.url === '/chat' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { text } = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      pushInput(text); return;
    }
    if (req.url === '/models' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ groups: CURATED_MODELS, active: state.activeModel })); return;
    }
    if (req.url === '/model' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { model } = JSON.parse(body);
      if (model) state.activeModel = model;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ active: state.activeModel }));
      broadcast({ type: 'model_changed', model: state.activeModel }); return;
    }
    if (req.url === '/clear' && req.method === 'POST') {
      messages.length = 0;
      messages.push({ role: 'system', content: systemPrompt() });
      res.writeHead(200); res.end(); return;
    }
    if (req.url === '/memory' && req.method === 'GET') {
      // Return memory entries as JSON array
      const { existsSync: ex, readFileSync: rf } = await import('node:fs');
      const DELIM = '\n\x15\n';
      const readMem = (file) => {
        if (!ex(file)) return [];
        const raw = rf(file, 'utf8').trim();
        return raw ? raw.split(DELIM).map((c, i) => ({ type: 'memory', content: c.trim() })).filter(m => m.content) : [];
      };
      const { PATHS: P } = await import('./paths.mjs');
      const all = [...readMem(P.agentMem), ...readMem(P.userMem)];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(all)); return;
    }
    res.writeHead(404); res.end();
  });

  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`\n  ${NAME} → ${url}\n`);
    const open = process.platform === 'darwin' ? `open "${url}"` : process.platform === 'win32' ? `start "" "${url}"` : `xdg-open "${url}" 2>/dev/null &`;
    execAsync(open).catch(() => {});
  });

  // Wire clarify for UI mode
  setRequestUserInput(async (question, choices) => {
    broadcast({ type: 'clarify', question, choices: choices || [] });
    return nextInput();
  });

  // Main UI loop
  while (true) {
    const input = await nextInput();
    if (!input) continue;
    if (input === '/forget') {
      messages.length = 0;
      messages.push({ role: 'system', content: systemPrompt() });
      broadcast({ type: 'system', text: 'Context cleared.' });
      broadcast({ type: 'done' }); continue;
    }
    if (input === '/mem') {
      const m = existsSync(PATHS.agentMem) ? readFileSync(PATHS.agentMem, 'utf8') : '(empty)';
      broadcast({ type: 'message', role: 'assistant', content: m });
      broadcast({ type: 'done' }); continue;
    }
    if (input.startsWith('/task ')) {
      const goal = input.slice(6).trim();
      try { await runTask(goal, messages, uiEmit); }
      catch (e) { broadcast({ type: 'error', message: e.message }); }
      continue;
    }
    messages.push({ role: 'user', content: input });
    try { await turn(messages, uiEmit); }
    catch (e) { broadcast({ type: 'error', message: e.message }); broadcast({ type: 'done' }); }
  }
}
