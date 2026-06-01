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

export const sseClients = new Set();
export function broadcast(event) {
  const data = 'data: ' + JSON.stringify(event) + '\n\n';
  for (const res of sseClients) {
    try { res.write(data); } catch { sseClients.delete(res); }
  }
}
export function uiEmit(event) { broadcast(event); }

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

function buildHTML(agentName) {
  const N = agentName;
  return [
    '<!DOCTYPE html><html lang="en"><head>',
    '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>' + N + '</title>',
    '<style>',
    '*{box-sizing:border-box;margin:0;padding:0}',
    ':root{--bg:#080808;--surface:#0f0f0f;--surface2:#141414;--border:#1e1e1e;--text:#d4d4d4;--dim:#444;--dim2:#666;--green:#00ff88;--green-dim:#00cc6a;--green-glow:rgba(0,255,136,.12);--red:#ff4455;--red-dim:#cc2233;--red-glow:rgba(255,68,85,.12);--yellow:#fbbf24;--blue:#60a5fa;}',
    'html,body{height:100%;background:var(--bg);color:var(--text);font-family:"SF Mono","Fira Code",Consolas,monospace;font-size:13px;line-height:1.6}',
    'body::after{content:"";position:fixed;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,.03) 2px,rgba(0,0,0,.03) 4px);pointer-events:none;z-index:9999}',
    '#app{display:flex;flex-direction:column;height:100vh;max-width:920px;margin:0 auto}',
    '#header{display:flex;align-items:center;gap:12px;padding:12px 20px;border-bottom:1px solid var(--border);flex-shrink:0;background:var(--surface)}',
    '#logo{font-size:15px;font-weight:700;letter-spacing:.12em;color:var(--green);text-shadow:0 0 12px rgba(0,255,136,.4);text-transform:uppercase}',
    '#logo-sub{font-size:10px;color:var(--dim2);letter-spacing:.06em;margin-left:2px;align-self:flex-end;margin-bottom:1px}',
    '#meta{color:var(--dim2);font-size:11px;flex:1}',
    '#mem-btn,#clear-btn{background:none;border:1px solid var(--border);color:var(--dim2);padding:4px 10px;border-radius:3px;cursor:pointer;font-family:inherit;font-size:11px;transition:all .15s}',
    '#mem-btn:hover{border-color:var(--green);color:var(--green)}',
    '#clear-btn:hover{border-color:var(--red);color:var(--red)}',
    '#model-select{background:var(--surface);border:1px solid var(--border);color:var(--dim2);padding:3px 6px;border-radius:3px;font-family:inherit;font-size:11px;cursor:pointer;outline:none;max-width:180px}',
    '#model-select:hover,#model-select:focus{border-color:var(--green);color:var(--green)}',
    '#status-dot{width:8px;height:8px;border-radius:50%;background:var(--green);flex-shrink:0;box-shadow:0 0 6px var(--green)}',
    '#status-dot.thinking{background:var(--yellow);box-shadow:0 0 6px var(--yellow);animation:pulse 1s infinite}',
    '@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}',
    '#agent-tabs{display:flex;align-items:center;gap:6px;padding:7px 20px;border-bottom:1px solid var(--border);background:var(--surface);flex-shrink:0;overflow-x:auto}',
    '.agent-tab{display:flex;align-items:center;gap:6px;background:none;border:1px solid var(--border);color:var(--dim2);padding:4px 12px;border-radius:4px;cursor:pointer;font-family:inherit;font-size:11px;white-space:nowrap;transition:all .15s}',
    '.agent-tab:hover{border-color:var(--green);color:var(--green)}',
    '.agent-tab.active{border-color:var(--green);color:var(--green);background:var(--green-glow)}',
    '.agent-tab.running .tab-dot{background:var(--yellow);animation:pulse 1s infinite}',
    '.agent-tab.done .tab-dot{background:var(--green-dim)}',
    '.agent-tab.error .tab-dot{background:var(--red)}',
    '.tab-dot{width:5px;height:5px;border-radius:50%;background:var(--dim);flex-shrink:0}',
    '#spawn-btn{background:none;border:1px dashed var(--border);color:var(--dim);padding:4px 10px;border-radius:4px;cursor:pointer;font-family:inherit;font-size:11px;transition:all .15s}',
    '#spawn-btn:hover{border-color:var(--blue);color:var(--blue)}',
    '#spawn-modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:200;align-items:center;justify-content:center}',
    '#spawn-modal.open{display:flex}',
    '#spawn-box{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;width:440px;display:flex;flex-direction:column;gap:12px}',
    '#spawn-box h3{color:var(--green);font-size:13px;letter-spacing:.1em;text-transform:uppercase}',
    '.spawn-field{display:flex;flex-direction:column;gap:4px}',
    '.spawn-label{font-size:10px;color:var(--dim2);letter-spacing:.08em;text-transform:uppercase}',
    '.spawn-input{background:var(--bg);border:1px solid var(--border);color:var(--text);padding:8px 10px;border-radius:4px;font-family:inherit;font-size:12px;outline:none}',
    '.spawn-input:focus{border-color:var(--green)}',
    '#spawn-goal{resize:vertical;min-height:72px}',
    '.spawn-actions{display:flex;gap:8px;justify-content:flex-end}',
    '.spawn-cancel{background:none;border:1px solid var(--border);color:var(--dim2);padding:6px 14px;border-radius:4px;cursor:pointer;font-family:inherit;font-size:11px}',
    '.spawn-cancel:hover{border-color:var(--red);color:var(--red)}',
    '.spawn-go{background:none;border:1px solid var(--green-dim);color:var(--green);padding:6px 16px;border-radius:4px;cursor:pointer;font-family:inherit;font-size:11px;font-weight:700}',
    '.spawn-go:hover{background:var(--green-glow)}',
    '#messages{flex:1;overflow:hidden;position:relative}',
    '.agent-pane{position:absolute;inset:0;overflow-y:auto;padding:24px 20px;display:flex;flex-direction:column;gap:14px;scroll-behavior:smooth;visibility:hidden;opacity:0;transition:opacity .15s}',
    '.agent-pane.active{visibility:visible;opacity:1}',
    '.agent-pane::-webkit-scrollbar{width:3px}',
    '.agent-pane::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}',
    '.msg{display:flex;flex-direction:column;gap:3px;max-width:82%}',
    '.msg.user{align-self:flex-end;align-items:flex-end}',
    '.msg.assistant{align-self:flex-start}',
    '.msg.system,.msg.sys{align-self:center;max-width:100%}',
    '.bubble{padding:10px 15px;border-radius:8px;white-space:pre-wrap;word-break:break-word;line-height:1.65}',
    '.msg.user .bubble{background:var(--red-glow);color:var(--red);border:1px solid var(--red-dim)}',
    '.msg.assistant .bubble{background:var(--green-glow);color:var(--green);border:1px solid rgba(0,255,136,.2)}',
    '.msg.system .bubble,.msg.sys .bubble{background:transparent;color:var(--dim2);font-size:11px;text-align:center;border:none;padding:4px}',
    '.label{font-size:10px;color:var(--dim);margin:0 3px;letter-spacing:.06em;text-transform:uppercase}',
    '.msg.user .label{color:var(--red-dim)}.msg.assistant .label{color:var(--green-dim)}',
    '.tools-block{background:var(--surface);border:1px solid var(--border);border-radius:6px;overflow:hidden;font-size:12px;align-self:flex-start;max-width:82%}',
    '.tools-header{display:flex;align-items:center;gap:8px;padding:7px 12px;cursor:pointer;user-select:none;color:var(--dim2)}',
    '.tools-header svg{flex-shrink:0;transition:transform .2s}',
    '.tools-header.open svg{transform:rotate(90deg)}',
    '.tools-list{padding:0 12px 10px;display:flex;flex-direction:column;gap:6px}',
    '.tool-item{display:flex;flex-direction:column;gap:2px}',
    '.tool-cmd{color:var(--green-dim)}',
    '.tool-result{color:var(--dim2);font-size:11px;white-space:pre-wrap;max-height:120px;overflow-y:auto}',
    '#todo-strip{display:flex;gap:8px;padding:6px 20px;border-bottom:1px solid var(--border);min-height:32px;flex-wrap:wrap;align-items:center;flex-shrink:0;background:var(--surface)}',
    '#todo-label{color:var(--dim);font-size:10px;letter-spacing:.1em;margin-right:4px;text-transform:uppercase}',
    '.t-item{display:flex;align-items:center;gap:5px;font-size:11px;padding:2px 8px;border-radius:3px;border:1px solid var(--border)}',
    '.t-item.pending{color:var(--dim2)}.t-item.in_progress{color:var(--yellow);border-color:rgba(251,191,36,.4)}.t-item.completed{color:var(--green-dim);opacity:.5}.t-dot{width:5px;height:5px;border-radius:50%;background:currentColor}',
    '.clarify-wrap{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}',
    '.clarify-btn{background:transparent;border:1px solid rgba(0,255,136,.3);color:var(--green);padding:5px 12px;border-radius:4px;cursor:pointer;font-family:inherit;font-size:12px;transition:all .15s}',
    '.clarify-btn:hover{border-color:var(--green);background:var(--green-glow)}',
    '#input-area{display:flex;gap:8px;padding:14px 20px;border-top:1px solid var(--border);flex-shrink:0;background:var(--surface)}',
    '#input-wrap{flex:1;position:relative;display:flex;align-items:center}',
    '#input-prefix{position:absolute;left:12px;color:var(--red);pointer-events:none}',
    '#input{flex:1;background:var(--bg);border:1px solid var(--red-dim);color:var(--red);padding:10px 14px 10px 28px;border-radius:6px;font-family:inherit;font-size:13px;resize:none;outline:none;min-height:42px;max-height:160px;caret-color:var(--red)}',
    '#input::placeholder{color:rgba(255,68,85,.3)}',
    '#input:focus{border-color:var(--red);box-shadow:0 0 10px var(--red-glow)}',
    '#send{background:transparent;border:1px solid var(--green-dim);color:var(--green);padding:10px 18px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}',
    '#send:hover{background:var(--green-glow)}',
    '#send:disabled{opacity:.3;cursor:default}',
    '#mem-panel{position:fixed;right:0;top:0;height:100%;width:320px;background:var(--surface);border-left:1px solid var(--border);display:flex;flex-direction:column;transform:translateX(100%);transition:transform .25s;z-index:100}',
    '#mem-panel.open{transform:translateX(0)}',
    '#mem-panel-header{display:flex;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--border)}',
    '#mem-panel-header h3{font-size:13px;color:var(--green-dim)}',
    '#close-mem{background:none;border:none;color:var(--dim2);cursor:pointer;font-size:18px}',
    '#mem-content{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px}',
    '.mem-item{background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px}',
    '.mem-type{font-size:10px;color:var(--dim);margin-bottom:3px;text-transform:uppercase}',
    '.mem-text{color:var(--text);font-size:12px;word-break:break-word}',
    '.mem-empty{color:var(--dim2);text-align:center;padding:20px;font-size:12px}',
    '.agent-toast{position:fixed;bottom:80px;right:20px;background:var(--surface);border:1px solid var(--green-dim);color:var(--green);padding:10px 16px;border-radius:6px;font-size:12px;z-index:300;cursor:pointer;animation:toastIn .2s ease}',
    '@keyframes toastIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}',
    '</style></head><body>',
    '<div id="app">',
    '  <div id="header">',
    '    <div id="status-dot"></div>',
    '    <div id="logo">&#9876; ' + N + '<span id="logo-sub">// goddess of wisdom</span></div>',
    '    <div id="meta"><select id="model-select"><option>' + MODEL + '</option></select></div>',
    '    <button id="clear-btn" onclick="clearCtx()">[ clear ]</button>',
    '    <button id="mem-btn" onclick="openMem()">[ memory ]</button>',
    '  </div>',
    '  <div id="agent-tabs">',
    '    <button class="agent-tab active" data-id="main" onclick="switchAgent(\'main\')">',
    '      <span class="tab-dot" style="background:var(--green-dim)"></span>' + N,
    '    </button>',
    '    <button id="spawn-btn" onclick="openSpawn()">+ New Agent</button>',
    '  </div>',
    '  <div id="todo-strip"><span id="todo-label">tasks</span></div>',
    '  <div id="messages"><div class="agent-pane active" data-id="main"></div></div>',
    '  <div id="input-area">',
    '    <div id="input-wrap"><span id="input-prefix">&gt;</span>',
    '      <textarea id="input" rows="1" placeholder="/task, /spawn &lt;name&gt; &lt;goal&gt;, /mem, /forget, /model ..." onkeydown="onKey(event)" oninput="resize(this)"></textarea>',
    '    </div>',
    '    <button id="send" onclick="sendMsg()">Send &#8594;</button>',
    '  </div>',
    '</div>',
    '<div id="spawn-modal">',
    '  <div id="spawn-box">',
    '    <h3>Spawn Background Agent</h3>',
    '    <div class="spawn-field"><div class="spawn-label">Agent Name</div><input class="spawn-input" id="spawn-name" type="text" placeholder="e.g. researcher, syscheck" /></div>',
    '    <div class="spawn-field"><div class="spawn-label">Task / Goal</div><textarea class="spawn-input" id="spawn-goal" placeholder="Describe what this agent should do..."></textarea></div>',
    '    <div class="spawn-actions"><button class="spawn-cancel" onclick="closeSpawn()">Cancel</button><button class="spawn-go" onclick="doSpawn()">Spawn &#8594;</button></div>',
    '  </div>',
    '</div>',
    '<div id="mem-panel">',
    '  <div id="mem-panel-header"><h3>Long-term memory</h3><button id="close-mem" onclick="closeMem()">&#x2715;</button></div>',
    '  <div id="mem-content"><div class="mem-empty">Loading...</div></div>',
    '</div>',
  ].join('\n');
}

function buildScript(agentName) {
  const N = agentName;
  return [
    '<script>',
    'const messagesWrap=document.getElementById("messages");',
    'const input=document.getElementById("input");',
    'const sendBtn=document.getElementById("send");',
    'const dot=document.getElementById("status-dot");',
    'const tabsEl=document.getElementById("agent-tabs");',
    'const spawnBtn=document.getElementById("spawn-btn");',
    'const agentState={main:{pane:document.querySelector(".agent-pane[data-id=\'main\']"),streamBubble:null,currentTools:null,pendingTools:{},busy:false,tab:null}};',
    'let activeAgentId="main";',
    'function getOrCreateAgent(id,name){',
    '  if(agentState[id])return agentState[id];',
    '  const pane=document.createElement("div");pane.className="agent-pane";pane.dataset.id=id;messagesWrap.appendChild(pane);',
    '  const tab=document.createElement("button");tab.className="agent-tab running";tab.dataset.id=id;',
    '  tab.onclick=()=>switchAgent(id);',
    '  tab.innerHTML="<span class=\'tab-dot\'></span>"+(name||id);',
    '  tabsEl.insertBefore(tab,spawnBtn);',
    '  const s={pane,tab,streamBubble:null,currentTools:null,pendingTools:{},busy:true};',
    '  agentState[id]=s;',
    '  addMsg(id,"sys","Agent " + (name||id) + " started...");',
    '  return s;',
    '}',
    'function switchAgent(id){',
    '  if(!agentState[id])return;activeAgentId=id;',
    '  for(const p of messagesWrap.querySelectorAll(".agent-pane"))p.classList.toggle("active",p.dataset.id===id);',
    '  for(const t of tabsEl.querySelectorAll(".agent-tab"))t.classList.toggle("active",t.dataset.id===id);',
    '  dot.className=agentState[id].busy?"thinking":"";',
    '}',
    'function scroll(id){const s=agentState[id];if(s&&s.pane)s.pane.scrollTop=s.pane.scrollHeight;}',
    'function addMsg(id,role,content){',
    '  const s=agentState[id];if(!s)return null;',
    '  const div=document.createElement("div");div.className="msg "+role;',
    '  const lbl=document.createElement("div");lbl.className="label";',
    '  lbl.textContent=role==="user"?"you":"' + N + '";',
    '  const bub=document.createElement("div");bub.className="bubble";bub.textContent=content;',
    '  div.appendChild(lbl);div.appendChild(bub);s.pane.appendChild(div);scroll(id);return bub;',
    '}',
    'function openToolBlock(id){',
    '  const s=agentState[id];if(!s)return null;',
    '  const b=document.createElement("div");b.className="tools-block";',
    '  b.innerHTML="<div class=\'tools-header\'><svg width=\'10\' height=\'10\' viewBox=\'0 0 10 10\'><polygon points=\'2,1 8,5 2,9\' fill=\'currentColor\'/></svg><span>tools</span></div><div class=\'tools-list\' style=\'display:none\'></div>";',
    '  b.querySelector(".tools-header").onclick=()=>{const l=b.querySelector(".tools-list");const open=l.style.display!=="none";l.style.display=open?"none":"flex";b.querySelector(".tools-header").classList.toggle("open",!open);};',
    '  s.pane.appendChild(b);scroll(id);return b;',
    '}',
    'function addToolItem(block,id,name,args){',
    '  const list=block.querySelector(".tools-list");list.style.display="flex";block.querySelector(".tools-header").classList.add("open");',
    '  const item=document.createElement("div");item.className="tool-item";',
    '  const cmd=document.createElement("div");cmd.className="tool-cmd";',
    '  const icons={run_shell:"$",web_search:"?",fetch_url:"@",read_file:"f",write_file:"w",edit_file:"e",memory:"m",spawn_agent:"*",workspace_read:"<",workspace_write:">"};',
    '  const lbl=name==="run_shell"?(args.command||"").slice(0,80):name==="web_search"?args.query:name==="spawn_agent"?(args.name||""):args.path||args.key||name;',
    '  cmd.textContent=(icons[name]||">")+lbl;item.appendChild(cmd);list.appendChild(item);scroll(id);return item;',
    '}',
    'const es=new EventSource("/events");',
    'es.onmessage=e=>{',
    '  const ev=JSON.parse(e.data);',
    '  const id=ev.agentId||"main";',
    '  if(id!=="main"&&!agentState[id])getOrCreateAgent(id,ev.agentName||id);',
    '  const s=agentState[id];if(!s)return;',
    '  if(ev.type==="status"){s.busy=true;s.currentTools=null;s.streamBubble=null;if(id===activeAgentId)dot.className="thinking";if(id==="main")sendBtn.disabled=true;}',
    '  if(ev.type==="stream_start"){',
    '    s.currentTools=null;',
    '    const wrap=document.createElement("div");wrap.className="msg assistant";',
    '    const lbl=document.createElement("div");lbl.className="label";lbl.textContent="' + N + '";',
    '    s.streamBubble=document.createElement("div");s.streamBubble.className="bubble";',
    '    wrap.appendChild(lbl);wrap.appendChild(s.streamBubble);s.pane.appendChild(wrap);scroll(id);',
    '  }',
    '  if(ev.type==="token"&&s.streamBubble){s.streamBubble.textContent+=ev.content;scroll(id);}',
    '  if(ev.type==="stream_end"){s.streamBubble=null;}',
    '  if(ev.type==="done"&&!ev.agentId){s.busy=false;if(id===activeAgentId)dot.className="";if(id==="main")sendBtn.disabled=false;}',
    '  if(ev.type==="agent_done"){',
    '    const ds=agentState[ev.agentId];if(ds){ds.busy=false;if(ds.tab){ds.tab.classList.remove("running");ds.tab.classList.add(ev.status==="done"?"done":"error");}}',
    '    if(ev.agentId===activeAgentId)dot.className="";',
    '    if(ev.agentId!==activeAgentId){const t=document.createElement("div");t.className="agent-toast";t.textContent="\\u2713 "+ev.agentName+" finished";t.onclick=()=>{switchAgent(ev.agentId);t.remove();};document.body.appendChild(t);setTimeout(()=>t.remove(),4000);}',
    '    addMsg(ev.agentId,"sys","Agent done ("+ev.status+")");',
    '  }',
    '  if(ev.type==="tool_start"){if(!s.currentTools)s.currentTools=openToolBlock(id);s.pendingTools[ev.name]=addToolItem(s.currentTools,id,ev.name,ev.args||{});}',
    '  if(ev.type==="tool_result"){',
    '    const item=s.pendingTools[ev.name];',
    '    if(item){let res=item.querySelector(".tool-result");if(!res){res=document.createElement("div");res.className="tool-result";item.appendChild(res);}res.textContent=String(ev.result||"").slice(0,300);delete s.pendingTools[ev.name];}',
    '    scroll(id);',
    '  }',
    '  if(ev.type==="todo_update"&&id==="main"){',
    '    const strip=document.getElementById("todo-strip");strip.innerHTML="<span id=\'todo-label\'>tasks</span>";',
    '    for(const t of(ev.todos||[])){const el=document.createElement("div");el.className="t-item "+t.status;const d=document.createElement("div");d.className="t-dot";el.appendChild(d);el.appendChild(document.createTextNode(t.content));strip.appendChild(el);}',
    '  }',
    '  if(ev.type==="clarify"){',
    '    s.currentTools=null;',
    '    const wrap=document.createElement("div");wrap.className="msg assistant";',
    '    const lbl=document.createElement("div");lbl.className="label";lbl.textContent="' + N + '";',
    '    const bub=document.createElement("div");bub.className="bubble";bub.textContent=ev.question;',
    '    const cw=document.createElement("div");cw.className="clarify-wrap";',
    '    for(const c of[...(ev.choices||[]),"Other..."]){',
    '      const btn=document.createElement("button");btn.className="clarify-btn";btn.textContent=c;',
    '      btn.onclick=()=>{cw.querySelectorAll(".clarify-btn").forEach(b=>b.disabled=true);cw.style.opacity=".4";input.value=c==="Other..."?"":c;if(c!=="Other...")sendMsg();else input.focus();};',
    '      cw.appendChild(btn);',
    '    }',
    '    bub.appendChild(cw);wrap.appendChild(lbl);wrap.appendChild(bub);s.pane.appendChild(wrap);scroll(id);',
    '    if(id==="main")sendBtn.disabled=false;if(id===activeAgentId)dot.className="";',
    '  }',
    '  if(ev.type==="system")addMsg(id,"sys",ev.text);',
    '  if(ev.type==="model_changed"){for(const opt of modelSel.options)opt.selected=opt.value===ev.model;}',
    '  if(ev.type==="error"){if(id==="main")sendBtn.disabled=false;addMsg(id,"sys","\\u26a0 "+ev.message);}',
    '};',
    'const modelSel=document.getElementById("model-select");',
    'async function loadModels(){try{const r=await fetch("/models");const{groups,active}=await r.json();modelSel.innerHTML="";let found=false;for(const group of groups){const grp=document.createElement("optgroup");grp.label=group.label;for(const m of group.models){const opt=document.createElement("option");opt.value=m;opt.textContent=m.includes("/")?m.split("/")[1].replace(/-instruct.*$/,""):m;opt.title=m;if(m===active){opt.selected=true;found=true;}grp.appendChild(opt);}modelSel.appendChild(grp);}if(!found){const opt=document.createElement("option");opt.value=active;opt.textContent=active;opt.selected=true;modelSel.prepend(opt);}}catch{}}',
    'modelSel.addEventListener("change",async()=>{await fetch("/model",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:modelSel.value})});});',
    'loadModels();',
    'function openSpawn(){document.getElementById("spawn-modal").classList.add("open");document.getElementById("spawn-name").focus();}',
    'function closeSpawn(){document.getElementById("spawn-modal").classList.remove("open");document.getElementById("spawn-name").value="";document.getElementById("spawn-goal").value="";}',
    'async function doSpawn(){const name=document.getElementById("spawn-name").value.trim();const goal=document.getElementById("spawn-goal").value.trim();if(!name||!goal)return;closeSpawn();await fetch("/spawn",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name,goal})});}',
    'document.getElementById("spawn-modal").addEventListener("click",e=>{if(e.target===document.getElementById("spawn-modal"))closeSpawn();});',
    'async function sendMsg(){const text=input.value.trim();if(!text||sendBtn.disabled)return;addMsg("main","user",text);input.value="";resize(input);sendBtn.disabled=true;dot.className="thinking";agentState.main.currentTools=null;await fetch("/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text})});}',
    'function onKey(e){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMsg();}}',
    'function resize(el){el.style.height="auto";el.style.height=Math.min(el.scrollHeight,160)+"px";}',
    'function clearCtx(){fetch("/clear",{method:"POST"});agentState.main.pane.innerHTML="";addMsg("main","sys","Context cleared.");}',
    'async function openMem(){document.getElementById("mem-panel").classList.add("open");const r=await fetch("/memory");const data=await r.json();const el=document.getElementById("mem-content");if(!data.length){el.innerHTML="<div class=\'mem-empty\'>No memories yet.</div>";return;}el.innerHTML="";for(const m of data){const item=document.createElement("div");item.className="mem-item";item.innerHTML="<div class=\'mem-type\'>"+(m.type||"note")+"</div><div class=\'mem-text\'>"+m.content+"</div>";el.appendChild(item);}}',
    'function closeMem(){document.getElementById("mem-panel").classList.remove("open");}',
    'addMsg("main","sys","' + N + ' online. Use + New Agent to run tasks in parallel.");',
    '</script></body></html>',
  ].join('\n');
}

export async function serveUI(messages) {
  const port = await getFreePort();
  process.env.ATHENA_UI = '1';

  let agentFns = null;
  async function getAgentFns() {
    if (!agentFns) {
      const { spawnAgent, listAgents } = await import('./agents.mjs');
      agentFns = { spawnAgent, listAgents };
    }
    return agentFns;
  }

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

  const HTML = buildHTML(NAME) + buildScript(NAME);

  const server = createServer(async (req, res) => {
    if (req.url === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML); return;
    }
    if (req.url === '/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
      res.write(':\n\n'); sseClients.add(res); req.on('close', () => sseClients.delete(res)); return;
    }
    if (req.url === '/chat' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const { text } = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
      pushInput(text); return;
    }
    if (req.url === '/spawn' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const { name, goal } = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (!name || !goal) { res.end('{"error":"name and goal required"}'); return; }
      const { spawnAgent } = await getAgentFns();
      const agentId = spawnAgent(name, goal, uiEmit);
      res.end(JSON.stringify({ agentId })); return;
    }
    if (req.url === '/agents' && req.method === 'GET') {
      const { listAgents } = await getAgentFns();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(listAgents())); return;
    }
    if (req.url === '/models' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ groups: CURATED_MODELS, active: state.activeModel })); return;
    }
    if (req.url === '/model' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const { model } = JSON.parse(body); if (model) state.activeModel = model;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ active: state.activeModel }));
      broadcast({ type: 'model_changed', model: state.activeModel }); return;
    }
    if (req.url === '/clear' && req.method === 'POST') {
      messages.length = 0; messages.push({ role: 'system', content: systemPrompt() });
      res.writeHead(200); res.end(); return;
    }
    if (req.url === '/memory' && req.method === 'GET') {
      const { existsSync: ex, readFileSync: rf } = await import('node:fs');
      const DELIM = '\n' + String.fromCharCode(21) + '\n';
      const readMem = f => ex(f) ? rf(f,'utf8').trim().split(DELIM).map(c=>({type:'memory',content:c.trim()})).filter(m=>m.content) : [];
      const { PATHS: P } = await import('./paths.mjs');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([...readMem(P.agentMem), ...readMem(P.userMem)])); return;
    }
    res.writeHead(404); res.end();
  });

  server.listen(port, '127.0.0.1', () => {
    const url = 'http://127.0.0.1:' + port;
    console.log('\n  ' + NAME + ' -> ' + url + '\n');
    const open = process.platform === 'darwin' ? 'open "' + url + '"' : process.platform === 'win32' ? 'start "" "' + url + '"' : 'xdg-open "' + url + '" 2>/dev/null &';
    execAsync(open).catch(() => {});
  });

  setRequestUserInput(async (question, choices) => {
    broadcast({ type: 'clarify', question, choices: choices || [] });
    return nextInput();
  });

  while (true) {
    const inp = await nextInput();
    if (!inp) continue;
    if (inp === '/forget') {
      messages.length = 0; messages.push({ role: 'system', content: systemPrompt() });
      broadcast({ type: 'system', text: 'Context cleared.' }); broadcast({ type: 'done' }); continue;
    }
    if (inp === '/mem') {
      const m = existsSync(PATHS.agentMem) ? readFileSync(PATHS.agentMem, 'utf8') : '(empty)';
      broadcast({ type: 'system', text: m }); broadcast({ type: 'done' }); continue;
    }
    if (inp.startsWith('/task ')) {
      const goal = inp.slice(6).trim();
      try { await runTask(goal, messages, uiEmit); }
      catch (e) { broadcast({ type: 'error', message: e.message }); }
      continue;
    }
    if (inp.startsWith('/spawn ')) {
      const rest = inp.slice(7).trim(); const si = rest.indexOf(' ');
      if (si !== -1) {
        const name = rest.slice(0, si); const goal = rest.slice(si + 1);
        const { spawnAgent } = await getAgentFns();
        const agentId = spawnAgent(name, goal, uiEmit);
        broadcast({ type: 'system', text: 'Agent "' + name + '" spawned (' + agentId + ')' });
      }
      broadcast({ type: 'done' }); continue;
    }
    messages.push({ role: 'user', content: inp });
    try { await turn(messages, uiEmit); }
    catch (e) { broadcast({ type: 'error', message: e.message }); broadcast({ type: 'done' }); }
  }
}
