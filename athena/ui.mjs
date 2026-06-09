// ui.mjs -- browser UI server, SSE broadcast, new Athena Web UI
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAME, MODEL, CURATED_MODELS, state } from './config.mjs';
import { PATHS } from './paths.mjs';
import { systemPrompt } from './personality.mjs';
import { turn, runTask, setRequestUserInput, setInterrupt } from './core.mjs';
import { setModelSwitchCallback } from './api.mjs';
import { saveAndSummarize, readEntries } from './memory.mjs';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = join(__dirname, 'athena.css');
const MAX_BODY = 1 * 1024 * 1024;

async function readBody(req, res) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end('{"error":"request too large"}');
      req.destroy(); return null;
    }
  }
  return body;
}

function parseJSON(body, res) {
  try { return JSON.parse(body); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end('{"error":"invalid json"}'); return null;
  }
}

const sseClients = new Set();
const _bootBuffer = [];
const _bootInputQueue = [];

export function broadcast(event) {
  const data = 'data: ' + JSON.stringify(event) + '\n\n';
  for (const res of sseClients) {
    try { res.write(data); } catch { sseClients.delete(res); }
  }
}
export function uiEmit(event) {
  if (sseClients.size === 0) { _bootBuffer.push(event); return; }
  broadcast(event);
}
export function queueBootInput(text) { _bootInputQueue.push(text); }

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

// ── Build HTML ────────────────────────────────────────────────────
function buildHTML(N) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${N}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&family=Hanken+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles/athena.css">
</head>
<body>

<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <symbol id="athena-mark" viewBox="0 0 100 100">
    <g class="laurel" fill="none" stroke="#B0813B" stroke-width="2.2" stroke-linecap="round">
      <path d="M28 80 Q13 58 21 31"/><path d="M72 80 Q87 58 79 31"/>
    </g>
    <g class="laurel" fill="#B0813B">
      <ellipse cx="18.5" cy="40" rx="5" ry="2.6" transform="rotate(-58 18.5 40)"/>
      <ellipse cx="17" cy="52" rx="5" ry="2.6" transform="rotate(-38 17 52)"/>
      <ellipse cx="20" cy="64" rx="5" ry="2.6" transform="rotate(-20 20 64)"/>
      <ellipse cx="81.5" cy="40" rx="5" ry="2.6" transform="rotate(58 81.5 40)"/>
      <ellipse cx="83" cy="52" rx="5" ry="2.6" transform="rotate(38 83 52)"/>
      <ellipse cx="80" cy="64" rx="5" ry="2.6" transform="rotate(20 80 64)"/>
    </g>
    <path d="M37 27 L33 17 L44 24 Z" fill="#6E7A4B"/>
    <path d="M63 27 L67 17 L56 24 Z" fill="#6E7A4B"/>
    <path d="M50 22 C65 22 73 34 73 49 C73 65 62 77 50 77 C38 77 27 65 27 49 C27 34 35 22 50 22 Z" fill="#EFE2C5" stroke="#6E7A4B" stroke-width="2.4"/>
    <path d="M31 44 Q40 36 49 43" fill="none" stroke="#6E7A4B" stroke-width="2.2" stroke-linecap="round"/>
    <path d="M69 44 Q60 36 51 43" fill="none" stroke="#6E7A4B" stroke-width="2.2" stroke-linecap="round"/>
    <circle cx="40" cy="50" r="9.2" fill="#FBF7EE" stroke="#6E7A4B" stroke-width="2.3"/>
    <circle cx="60" cy="50" r="9.2" fill="#FBF7EE" stroke="#6E7A4B" stroke-width="2.3"/>
    <circle class="eye-pupil" cx="40" cy="50" r="3.7" fill="#3E6E8E"/>
    <circle class="eye-pupil" cx="60" cy="50" r="3.7" fill="#3E6E8E"/>
    <path d="M50 55 L45.5 62 L54.5 62 Z" fill="#B0813B"/>
  </symbol>
  <symbol id="i-chat" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></symbol>
  <symbol id="i-grid" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/></symbol>
  <symbol id="i-book" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></symbol>
  <symbol id="i-spark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/></symbol>
  <symbol id="i-agents" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><circle cx="17.5" cy="9.5" r="2.4"/><path d="M16 20a4 4 0 0 1 6 0"/></symbol>
  <symbol id="i-clock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></symbol>
  <symbol id="i-gear" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7.7 1.6 1.6 0 0 0-1 1.5V22a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1-.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H2a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H8a1.6 1.6 0 0 0 1-1.5V2a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V8a1.6 1.6 0 0 0 1.5 1H22a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></symbol>
  <symbol id="i-search" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></symbol>
  <symbol id="i-bell" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></symbol>
  <symbol id="i-mic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></symbol>
  <symbol id="i-plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></symbol>
  <symbol id="i-send" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 6l6 6-6 6"/></symbol>
  <symbol id="i-attach" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5 12.5 20a4.5 4.5 0 0 1-6.4-6.4l8.5-8.5a3 3 0 0 1 4.2 4.2l-8.5 8.5a1.5 1.5 0 0 1-2.1-2.1l7.8-7.8"/></symbol>
  <symbol id="i-caret" viewBox="0 0 10 10"><path d="M3 1.5 7 5 3 8.5z" fill="currentColor"/></symbol>
  <symbol id="i-check" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.5 5 9l4.5-5"/></symbol>
  <symbol id="i-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></symbol>
  <symbol id="i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M18.4 5.6l1.4-1.4M4.2 19.8l1.4-1.4"/></symbol>
  <symbol id="i-stop" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></symbol>
</svg>

<select id="model-select" style="display:none"></select>

<div class="app" id="app">

  <aside class="rail">
    <div class="brand">
      <svg class="mark" viewBox="0 0 100 100"><use href="#athena-mark"/></svg>
      <div><div class="brand-name">${N}</div><div class="brand-sub">Goddess of Wisdom</div></div>
    </div>
    <div class="nav-eyebrow">Workspace</div>
    <nav class="nav" id="nav">
      <div class="nav-item active" data-view="chat"><svg><use href="#i-chat"/></svg>Conversation</div>
      <div class="nav-item" data-view="dash"><svg><use href="#i-grid"/></svg>Dashboard</div>
    </nav>
    <div class="nav-eyebrow">Her Mind</div>
    <nav class="nav">
      <div class="nav-item" data-view="memory"><svg><use href="#i-book"/></svg>Memory <span class="nav-badge" id="badge-memory">0</span></div>
      <div class="nav-item" data-view="skills"><svg><use href="#i-spark"/></svg>Skills <span class="nav-badge" id="badge-skills">0</span></div>
      <div class="nav-item" data-view="agents"><svg><use href="#i-agents"/></svg>Agents <span class="nav-badge" id="badge-agents">0</span></div>
      <div class="nav-item" data-view="sessions"><svg><use href="#i-clock"/></svg>Sessions</div>
      <div class="nav-item" data-view="settings"><svg><use href="#i-gear"/></svg>Settings</div>
    </nav>
    <div class="rail-foot">
      <button class="theme-btn" id="themeBtn"><svg id="themeIco"><use href="#i-moon"/></svg><span id="themeLbl">Evening</span></button>
      <div class="watch-pill"><span class="dot"></span>Watcher active</div>
      <div class="provider">
        <div class="provider-row">
          <div class="provider-logo anthropic">A</div>
          <div class="provider-meta"><b>Model</b><span id="active-model-lbl">${MODEL}</span></div>
          <button class="provider-switch" id="model-switch-btn">switch</button>
        </div>
        <select id="model-select-inline" style="display:none;width:100%;margin-top:6px;background:var(--paper-1);border:1px solid var(--line);border-radius:6px;padding:4px 6px;font-family:var(--font-mono);font-size:11px;color:var(--ink-2)"></select>
      </div>
    </div>
  </aside>

  <!-- CHAT VIEW -->
  <main class="main" id="view-chat">
    <div class="topbar">
      <div><h1>Conversation</h1><div class="sub" id="topbar-sub">Starting up...</div></div>
      <span class="chip" id="machine-chip"><svg><use href="#i-grid"/></svg>Local machine</span>
      <div class="topbar-actions">
        <button class="icon-btn" id="stop-btn" title="Stop" style="display:none"><svg><use href="#i-stop"/></svg></button>
        <button class="icon-btn" id="clear-btn" title="Clear context"><svg><use href="#i-bell"/></svg></button>
      </div>
    </div>
    <div class="thread" id="thread">
      <div class="thread-inner" id="thread-inner">
        <div class="welcome">
          <div class="presence-orb" id="presence-orb"><span class="halo"></span><span class="ring" id="presence-ring"></span><svg class="mark" viewBox="0 0 100 100"><use href="#athena-mark"/></svg></div>
          <h2 id="welcome-heading">Hello.</h2>
          <p>I'm here and keeping an eye on this machine. Ask me anything, give me a task, or just think out loud.</p>
        </div>
      </div>
    </div>
    <div class="composer-wrap">
      <div class="composer">
        <div class="composer-tools">
          <button class="c-btn" id="micBtn" title="Hold Space to talk"><svg><use href="#i-mic"/></svg></button>
        </div>
        <textarea id="composer-input" rows="1" placeholder="Ask ${N}, give her a task, or type / for commands..."></textarea>
        <button class="send-btn" id="send-btn"><svg><use href="#i-send"/></svg></button>
      </div>
      <div class="composer-hint">
        <span><kbd>/task</kbd> multi-step goal</span>
        <span><kbd>/spawn</kbd> background agent</span>
        <span><kbd>Space</kbd> hold to talk</span>
        <span><kbd>Shift+Enter</kbd> newline</span>
      </div>
    </div>
  </main>

  <!-- RIGHT CONTEXT RAIL -->
  <aside class="context" id="ctx">
    <div class="ctx-card">
      <div class="presence-hero">
        <div class="presence-orb" id="ctx-orb"><span class="halo"></span><span class="ring"></span><svg class="mark" viewBox="0 0 100 100"><use href="#athena-mark"/></svg></div>
        <div class="presence-state" id="ctx-state">Present &amp; attentive</div>
        <div class="presence-doing" id="ctx-doing">Listening.</div>
        <div class="presence-meta">
          <span class="mini-pill" id="ctx-model">${MODEL}</span>
          <span class="mini-pill" id="ctx-tools">0 tools used</span>
          <span class="mini-pill" id="ctx-tier">tier 0 autonomy</span>
        </div>
      </div>
    </div>
    <div class="ctx-card">
      <div class="head"><h3>She's Watching</h3><span class="count">sentinels</span></div>
      <div class="watch-list" id="watch-list">
        <div class="watch-row"><div class="watch-ico bg-olive">&#128737;</div><div class="watch-info"><b>Disk space</b><span>Monitoring</span></div><span class="status-dot ok"></span></div>
        <div class="watch-row"><div class="watch-ico bg-terra">&#127777;</div><div class="watch-info"><b>CPU temperature</b><span>Monitoring</span></div><span class="status-dot ok"></span></div>
        <div class="watch-row"><div class="watch-ico bg-lapis">&#127760;</div><div class="watch-info"><b>Network</b><span>Monitoring</span></div><span class="status-dot ok"></span></div>
      </div>
    </div>
    <div class="ctx-card">
      <div class="head"><h3>Helpers</h3><span class="count" id="helpers-count">0 agents</span></div>
      <div class="agent-list" id="helpers-list">
        <div style="font-size:12px;color:var(--ink-3);padding:8px 0">No agents running.</div>
        <button class="add-agent" id="spawn-agent-btn"><svg width="14" height="14"><use href="#i-plus"/></svg>Send out a helper</button>
      </div>
    </div>
  </aside>

  <!-- DASHBOARD VIEW -->
  <main class="main" id="view-dash" style="display:none">
    <div class="topbar">
      <div><h1>Dashboard</h1><div class="sub">Everything ${N} knows about this machine</div></div>
      <span class="chip"><span class="dot"></span>All systems</span>
    </div>
    <div class="dash"><div class="dash-inner">
      <div class="dash-hero">
        <div class="presence-orb"><span class="halo"></span><svg class="mark" viewBox="0 0 100 100"><use href="#athena-mark"/></svg></div>
        <div class="dash-hero-text"><h2 id="dash-greeting">Hello.</h2><p id="dash-summary">Loading machine data...</p></div>
        <div class="dash-hero-stats">
          <div class="dash-stat"><div class="v" id="stat-skills">0</div><div class="l">Skills</div></div>
          <div class="dash-stat"><div class="v" id="stat-memory">0</div><div class="l">Memories</div></div>
          <div class="dash-stat"><div class="v" id="stat-agents">0</div><div class="l">Agents ever</div></div>
        </div>
      </div>
      <div class="dash-grid">
        <div class="card col-7">
          <div class="card-head"><div class="ci bg-olive"><svg width="17" height="17" style="color:var(--olive-deep)"><use href="#i-grid"/></svg></div><h3>Machine</h3></div>
          <div class="health-grid" id="dash-machine-grid">
            <div class="health-tile"><div class="ht-ico bg-olive">&#128736;</div><div><b>OS</b><span id="dash-os">Loading...</span></div></div>
            <div class="health-tile"><div class="ht-ico bg-lapis">&#128187;</div><div><b>CPU</b><span id="dash-cpu">Loading...</span></div></div>
            <div class="health-tile"><div class="ht-ico bg-bronze">&#128190;</div><div><b>RAM</b><span id="dash-ram">Loading...</span></div></div>
            <div class="health-tile"><div class="ht-ico bg-terra">&#128204;</div><div><b>Disk</b><span id="dash-disk">Loading...</span></div></div>
          </div>
        </div>
        <div class="card col-5">
          <div class="card-head"><div class="ci bg-bronze"><svg width="17" height="17" style="color:var(--bronze-deep)"><use href="#i-book"/></svg></div><h3>Memory</h3></div>
          <div class="flex between" style="font-size:12px;color:var(--ink-3)"><span>Long-term store</span><span id="mem-pct">0%</span></div>
          <div class="meter"><span id="mem-bar" style="width:0%"></span></div>
          <div class="mem-line"><span>Memories</span><b id="dash-mem-count">0</b></div>
          <div class="mem-line"><span>Instincts</span><b id="dash-instinct-count">0</b></div>
        </div>
        <div class="card col-12">
          <div class="card-head"><div class="ci bg-bronze"><svg width="17" height="17" style="color:var(--bronze-deep)"><use href="#i-spark"/></svg></div><h3>Skills</h3></div>
          <div class="skills-grid" id="dash-skills-grid"></div>
        </div>
      </div>
    </div></div>
  </main>

  <!-- MEMORY VIEW -->
  <main class="main" id="view-memory" style="display:none">
    <div class="topbar"><div><h1>Memory</h1><div class="sub">What ${N} carries across every session</div></div></div>
    <div class="dash"><div class="dash-inner" style="max-width:1000px">
      <div class="section-title">All memories<span class="eyebrow" id="mem-view-eyebrow">loading...</span></div>
      <div class="mem-grid" id="mem-view-grid"><div style="color:var(--ink-3);padding:20px 0">Loading...</div></div>
    </div></div>
  </main>

  <!-- SKILLS VIEW -->
  <main class="main" id="view-skills" style="display:none">
    <div class="topbar"><div><h1>Skills</h1><div class="sub">The library ${N} builds for herself</div></div>
      <span class="chip" id="skills-chip"><span class="dot"></span>Loading...</span>
    </div>
    <div class="dash"><div class="dash-inner">
      <div class="skills-grid" id="skills-view-grid"><div style="color:var(--ink-3);padding:20px 0">Loading...</div></div>
    </div></div>
  </main>

  <!-- AGENTS VIEW -->
  <main class="main" id="view-agents" style="display:none">
    <div class="topbar">
      <div><h1>Helpers</h1><div class="sub">Background agents working in parallel -- CORAL network</div></div>
      <button class="icon-btn" style="margin-left:auto;width:auto;padding:0 14px;gap:8px;font-size:12.5px;font-weight:600" id="agents-spawn-btn"><svg><use href="#i-plus"/></svg>Spawn helper</button>
    </div>
    <div class="dash"><div class="dash-inner">
      <div class="section-title">Active &amp; recent<span class="eyebrow">isolated histories, shared workspace</span></div>
      <div class="skills-grid" id="agents-view-grid" style="margin-bottom:26px">
        <div style="color:var(--ink-3);padding:20px 0">No agents yet this session.</div>
      </div>
      <div class="coral">
        <div class="ch"><svg width="17" height="17" style="color:var(--olive)"><use href="#i-agents"/></svg><h3>CORAL log</h3><span class="v" id="coral-version">v0</span></div>
        <div class="coral-feed" id="coral-feed">
          <div class="coral-row"><span class="cv">--</span><span class="cdot" style="background:var(--ink-3)"></span><span class="ctext">No CORAL entries yet this session.</span></div>
        </div>
      </div>
    </div></div>
  </main>

  <!-- SESSIONS VIEW -->
  <main class="main" id="view-sessions" style="display:none">
    <div class="topbar"><div><h1>Sessions</h1><div class="sub">Every conversation, summarised</div></div></div>
    <div class="dash"><div class="dash-inner" style="max-width:920px">
      <div class="section-title">Recent</div>
      <div class="card" style="padding:6px 20px" id="sessions-list">
        <div class="session-row"><span class="when">--</span><span class="what">Loading session history...</span><span class="tools"></span></div>
      </div>
    </div></div>
  </main>

  <!-- SETTINGS VIEW -->
  <main class="main" id="view-settings" style="display:none">
    <div class="topbar"><div><h1>Settings</h1><div class="sub">How ${N} behaves on this machine</div></div></div>
    <div class="dash"><div class="dash-inner">
      <div class="set-wrap">
        <div class="set-section">
          <div class="sh"><div class="ci bg-olive"><svg width="17" height="17" style="color:var(--olive-deep)"><use href="#i-agents"/></svg></div><div><h3>Model</h3><p>Active language model</p></div></div>
          <div class="set-row"><div class="sr-text"><b>Current model</b><span>Switch to any available model</span></div>
            <div class="sr-control"><select id="settings-model-select" style="background:var(--paper-1);border:1px solid var(--line);border-radius:6px;padding:6px 10px;font-family:var(--font-mono);font-size:12px;color:var(--ink-1)"></select></div></div>
        </div>
        <div class="set-section">
          <div class="sh"><div class="ci bg-bronze"><svg width="17" height="17" style="color:var(--bronze-deep)"><use href="#i-spark"/></svg></div><div><h3>Autonomy</h3><p>How much ${N} does without asking</p></div></div>
          <div class="set-row"><div class="sr-text"><b>Tier 0 -- read-only</b><span>Runs silently, never logged</span></div><div class="sr-control"><span class="tier-tag" style="background:var(--wash-olive);color:var(--olive-deep)">always on</span></div></div>
          <div class="set-row"><div class="sr-text"><b>Tier 1 -- low-impact writes</b><span>Runs automatically, written to audit trail</span></div><div class="sr-control"><span class="tier-tag" style="background:var(--wash-olive);color:var(--olive-deep)">auto</span></div></div>
          <div class="set-row"><div class="sr-text"><b>Tier 2 -- destructive actions</b><span>Always pause for explicit approval</span></div><div class="sr-control"><span class="tier-tag" style="background:var(--wash-terra);color:var(--terra-deep)">locked on</span></div></div>
        </div>
        <div class="set-section">
          <div class="sh"><div class="ci bg-lapis"><svg width="17" height="17" style="color:var(--lapis-deep)"><use href="#i-mic"/></svg></div><div><h3>Voice &amp; appearance</h3><p>How you talk to her, and how she looks</p></div></div>
          <div class="set-row"><div class="sr-text"><b>Theme</b><span>Day marble or warm evening</span></div><div class="sr-control"><div class="seg" id="theme-seg"><button class="on" data-theme="day">Day</button><button data-theme="evening">Evening</button></div></div></div>
        </div>
        <div class="set-section">
          <div class="sh"><div class="ci bg-bronze"><svg width="17" height="17" style="color:var(--bronze-deep)"><use href="#i-book"/></svg></div><div><h3>Memory</h3><p>Long-term store</p></div></div>
          <div class="set-row"><div class="sr-text"><b>Forget this session</b><span>Clears conversation -- long-term memory stays intact</span></div><div class="sr-control"><button class="btn-sm" id="forget-btn" style="border-color:var(--danger);color:var(--danger)">Forget</button></div></div>
        </div>
      </div>
    </div></div>
  </main>

</div>`;
}

// ── Build Script ──────────────────────────────────────────────────
function buildScript(N) {
  return `<script>
(function(){
'use strict';

// ── State ────────────────────────────────────────────────────────
const S = {
  streaming: false,
  streamBuf: '',
  streamEl: null,
  toolsUsed: 0,
  curTier: 0,
  agents: {},
  models: [],
  currentModel: '',
  theme: localStorage.getItem('athena-theme') || 'day',
};

// ── Helpers ──────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}
function fmt(s) {
  // inline code
  s = s.replace(/\\\`([^\\\`\\n]+)\\\`/g,'<code>$1</code>');
  // bold
  s = s.replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>');
  // bold single
  s = s.replace(/\\*([^*\\n]+)\\*/g,'<em>$1</em>');
  // newlines
  s = s.replace(/\\n/g,'<br>');
  return s;
}
function ts() { return new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); }
function initials(n) {
  return (n||'You').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
}

const thread = document.getElementById('thread-inner');
const PRESENCE_ORB = document.getElementById('presence-ring');
const CTX_STATE = document.getElementById('ctx-state');
const CTX_DOING = document.getElementById('ctx-doing');
const CTX_TOOLS = document.getElementById('ctx-tools');
const CTX_TIER  = document.getElementById('ctx-tier');
const TOPBAR_SUB = document.getElementById('topbar-sub');
const STOP_BTN   = document.getElementById('stop-btn');

// ── View switching ───────────────────────────────────────────────
const views = {
  chat:     document.getElementById('view-chat'),
  dash:     document.getElementById('view-dash'),
  memory:   document.getElementById('view-memory'),
  skills:   document.getElementById('view-skills'),
  agents:   document.getElementById('view-agents'),
  sessions: document.getElementById('view-sessions'),
  settings: document.getElementById('view-settings'),
};
const ctx = document.getElementById('ctx');

function showView(v) {
  Object.entries(views).forEach(([k, el]) => {
    el.style.display = k === v ? '' : 'none';
  });
  ctx.style.display = v === 'chat' ? '' : 'none';
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.view === v);
  });
  if (v === 'dash')     loadDash();
  if (v === 'memory')   loadMemory();
  if (v === 'skills')   loadSkills();
  if (v === 'agents')   loadAgentsView();
  if (v === 'sessions') loadSessions();
}

document.getElementById('nav').addEventListener('click', e => {
  const item = e.target.closest('.nav-item');
  if (!item) return;
  showView(item.dataset.view);
});
document.querySelectorAll('.nav-item[data-view]').forEach(el => {
  el.addEventListener('click', () => showView(el.dataset.view));
});

// ── Theme ────────────────────────────────────────────────────────
function applyTheme(t) {
  S.theme = t;
  document.documentElement.setAttribute('data-theme', t === 'evening' ? 'evening' : '');
  localStorage.setItem('athena-theme', t);
  document.getElementById('themeLbl').textContent = t === 'evening' ? 'Day' : 'Evening';
  const ico = document.getElementById('themeIco');
  ico.innerHTML = t === 'evening'
    ? '<use href="#i-sun"/>'
    : '<use href="#i-moon"/>';
  document.querySelectorAll('.seg button').forEach(b => {
    b.classList.toggle('on', b.dataset.theme === t);
  });
}
applyTheme(S.theme);
document.getElementById('themeBtn').addEventListener('click', () =>
  applyTheme(S.theme === 'evening' ? 'day' : 'evening'));
document.querySelectorAll('.seg button').forEach(b =>
  b.addEventListener('click', () => applyTheme(b.dataset.theme)));

// ── Presence helpers ─────────────────────────────────────────────
function setPresence(state) {
  const ring = PRESENCE_ORB;
  if (!ring) return;
  ring.className = 'ring' + (state ? ' ' + state : '');
  const ctxOrb = document.querySelector('#ctx-orb .ring');
  if (ctxOrb) ctxOrb.className = 'ring' + (state ? ' ' + state : '');
  const ctxState = CTX_STATE;
  const ctxDoing = CTX_DOING;
  if (state === 'thinking') {
    if (ctxState) ctxState.textContent = 'Thinking deeply...';
    if (ctxDoing) ctxDoing.textContent = 'Processing your request.';
    if (TOPBAR_SUB) TOPBAR_SUB.textContent = 'Thinking...';
    if (STOP_BTN) STOP_BTN.style.display = '';
  } else if (state === 'typing') {
    if (ctxState) ctxState.textContent = 'Writing...';
    if (ctxDoing) ctxDoing.textContent = 'Composing a response.';
    if (TOPBAR_SUB) TOPBAR_SUB.textContent = 'Responding...';
    if (STOP_BTN) STOP_BTN.style.display = '';
  } else if (state === 'tool') {
    if (ctxState) ctxState.textContent = 'Using a tool...';
    if (ctxDoing) ctxDoing.textContent = 'Acting on your behalf.';
  } else {
    if (ctxState) ctxState.textContent = 'Present & attentive';
    if (ctxDoing) ctxDoing.textContent = 'Listening.';
    if (TOPBAR_SUB) TOPBAR_SUB.textContent = 'Ready';
    if (STOP_BTN) STOP_BTN.style.display = 'none';
  }
}

// ── Message builders ─────────────────────────────────────────────
function appendSep(label) {
  const d = document.createElement('div');
  d.className = 'day-sep';
  d.innerHTML = '<span>' + esc(label) + '</span>';
  thread.appendChild(d);
}

function appendUserMsg(text) {
  // Remove welcome if present
  const w = thread.querySelector('.welcome');
  if (w) w.remove();
  const d = document.createElement('div');
  d.className = 'msg you';
  d.innerHTML =
    '<div class="av av-you">' + esc(initials('You')) + '</div>' +
    '<div class="bubble-wrap">' +
    '<div class="sender"><b>You</b><time>' + ts() + '</time></div>' +
    '<div class="bubble">' + fmt(esc(text)) + '</div>' +
    '</div>';
  thread.appendChild(d);
  scrollBottom();
  return d;
}

function startAthenaMsg() {
  const w = thread.querySelector('.welcome');
  if (w) w.remove();
  const d = document.createElement('div');
  d.className = 'msg athena';
  d.innerHTML =
    '<div class="av av-athena"><svg viewBox="0 0 100 100"><use href="#athena-mark"/></svg></div>' +
    '<div class="bubble-wrap">' +
    '<div class="sender"><b>${N}</b><time>' + ts() + '</time></div>' +
    '<div class="bubble" id="streaming-bubble"></div>' +
    '</div>';
  thread.appendChild(d);
  S.streamEl = d.querySelector('#streaming-bubble');
  S.streamBuf = '';
  scrollBottom();
  return d;
}

function finaliseStreaming() {
  if (!S.streamEl) return;
  S.streamEl.id = '';
  S.streamEl.innerHTML = fmt(esc(S.streamBuf));
  S.streamEl = null;
  S.streamBuf = '';
  scrollBottom();
}

function appendAthenaMsg(text) {
  const w = thread.querySelector('.welcome');
  if (w) w.remove();
  const d = document.createElement('div');
  d.className = 'msg athena';
  d.innerHTML =
    '<div class="av av-athena"><svg viewBox="0 0 100 100"><use href="#athena-mark"/></svg></div>' +
    '<div class="bubble-wrap">' +
    '<div class="sender"><b>${N}</b><time>' + ts() + '</time></div>' +
    '<div class="bubble">' + fmt(esc(text)) + '</div>' +
    '</div>';
  thread.appendChild(d);
  scrollBottom();
  return d;
}

function appendSysMsg(text) {
  const d = document.createElement('div');
  d.className = 'day-sep';
  d.innerHTML = '<span>' + esc(text) + '</span>';
  thread.appendChild(d);
  scrollBottom();
}

function appendToolBlock(toolName, args, tier) {
  const tierClass = tier >= 2 ? 'tier-2' : tier === 1 ? 'tier-1' : 'tier-0';
  const tierLabel = tier >= 2 ? 'T2' : tier === 1 ? 'T1' : 'T0';
  const glyph = tier >= 2 ? '&#9888;' : '&#9881;';
  const d = document.createElement('div');
  d.className = 'tool-scroll open';
  const argsStr = typeof args === 'object' ? JSON.stringify(args, null, 2) : String(args||'');
  d.innerHTML =
    '<div class="tool-head">' +
    '<span class="tool-glyph">' + glyph + '</span>' +
    '<span class="tool-name">' + esc(toolName) + '</span>' +
    '<span class="tier-badge ' + tierClass + '">' + tierLabel + '</span>' +
    '<svg class="tool-caret" width="10" height="10"><use href="#i-caret"/></svg>' +
    '</div>' +
    '<div class="tool-body">' +
    '<div class="code-line">' + esc(argsStr) + '</div>' +
    '<div class="tool-out" id="tout-' + esc(toolName) + '-' + Date.now() + '"><em>Running...</em></div>' +
    '</div>';
  d.querySelector('.tool-head').addEventListener('click', () => d.classList.toggle('open'));
  thread.appendChild(d);
  scrollBottom();
  return d;
}

function appendGate(toolName, args, tier) {
  const argsStr = typeof args === 'object' ? JSON.stringify(args, null, 2) : String(args||'');
  const d = document.createElement('div');
  d.className = 'gate';
  d.innerHTML =
    '<div class="gate-top"><span class="gate-ico">&#9888;</span>' +
    '<div><b>Approval required</b><span>Tier ' + tier + ' action -- ' + esc(toolName) + '</span></div></div>' +
    '<pre class="cmd">' + esc(argsStr) + '</pre>' +
    '<div class="gate-actions">' +
    '<button class="gate-approve">Approve once</button>' +
    '<button class="gate-deny">Not now</button>' +
    '</div>';
  d.querySelector('.gate-approve').addEventListener('click', () => {
    send('yes'); d.remove();
  });
  d.querySelector('.gate-deny').addEventListener('click', () => {
    send('no'); d.remove();
  });
  thread.appendChild(d);
  scrollBottom();
  return d;
}

function appendTaskCard(tasks) {
  const d = document.createElement('div');
  d.className = 'task-card';
  let rows = '';
  tasks.forEach(t => {
    const cls = t.done ? 'done' : t.active ? 'now' : 'todo';
    const ico = t.done ? '<svg width="12" height="12"><use href="#i-check"/></svg>' :
                t.active ? '<span class="doing-dot"></span>' : '<span class="todo-num"></span>';
    rows += '<div class="task-row ' + cls + '">' + ico + '<span>' + esc(t.text) + '</span></div>';
  });
  d.innerHTML = rows;
  thread.appendChild(d);
  scrollBottom();
  return d;
}

// ── Current tool block tracking ──────────────────────────────────
let _curToolBlock = null;
let _curToolOutEl = null;

// ── SSE ──────────────────────────────────────────────────────────
let _es = null;
function connectSSE() {
  if (_es) _es.close();
  _es = new EventSource('/events');
  _es.onmessage = e => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    handleEvent(ev);
  };
  _es.onerror = () => {
    setPresence('');
    appendSysMsg('Connection lost -- reconnecting...');
    setTimeout(connectSSE, 3000);
  };
}

function handleEvent(ev) {
  switch (ev.type) {

    case 'status':
      if (ev.text) {
        if (TOPBAR_SUB) TOPBAR_SUB.textContent = ev.text;
        if (CTX_DOING) CTX_DOING.textContent = ev.text;
      }
      break;

    case 'stream_start':
      S.streaming = true;
      setPresence('typing');
      startAthenaMsg();
      break;

    case 'token':
      if (S.streamEl) {
        S.streamBuf += ev.text || '';
        S.streamEl.textContent = S.streamBuf;
        scrollBottom();
      }
      break;

    case 'stream_end':
      S.streaming = false;
      finaliseStreaming();
      setPresence('');
      break;

    case 'done':
      S.streaming = false;
      if (S.streamEl) finaliseStreaming();
      setPresence('');
      if (ev.text && !S.streamBuf) appendAthenaMsg(ev.text);
      break;

    case 'tool_start': {
      setPresence('tool');
      S.toolsUsed++;
      if (CTX_TOOLS) CTX_TOOLS.textContent = S.toolsUsed + ' tool' + (S.toolsUsed===1?'':'s') + ' used';
      const tier = ev.tier || 0;
      if (tier > S.curTier) {
        S.curTier = tier;
        if (CTX_TIER) CTX_TIER.textContent = 'tier ' + tier + ' autonomy';
      }
      _curToolBlock = appendToolBlock(ev.name || ev.tool, ev.args, tier);
      _curToolOutEl = _curToolBlock ? _curToolBlock.querySelector('.tool-out') : null;
      break;
    }

    case 'tool_result':
      if (_curToolOutEl) {
        const out = ev.result || ev.output || '';
        const s = typeof out === 'object' ? JSON.stringify(out, null, 2) : String(out);
        _curToolOutEl.textContent = s.length > 800 ? s.slice(0, 800) + '...' : s;
        _curToolOutEl.removeAttribute('class');
        _curToolOutEl.className = 'tool-out done';
      }
      _curToolBlock = null;
      _curToolOutEl = null;
      setPresence('thinking');
      break;

    case 'todo_update': {
      const tasks = Array.isArray(ev.tasks) ? ev.tasks : [];
      // Find existing task card or create new one
      let card = thread.querySelector('.task-card:last-of-type');
      if (!card) {
        card = appendTaskCard(tasks);
      } else {
        let rows = '';
        tasks.forEach(t => {
          const cls = t.done ? 'done' : t.active ? 'now' : 'todo';
          const ico = t.done ? '<svg width="12" height="12"><use href="#i-check"/></svg>' :
                      t.active ? '<span class="doing-dot"></span>' : '<span class="todo-num"></span>';
          rows += '<div class="task-row ' + cls + '">' + ico + '<span>' + esc(t.text) + '</span></div>';
        });
        card.innerHTML = rows;
      }
      scrollBottom();
      break;
    }

    case 'approval_required':
      setPresence('');
      appendGate(ev.tool || ev.name, ev.args, ev.tier || 2);
      break;

    case 'clarify':
      setPresence('');
      appendAthenaMsg(ev.text || ev.question || '');
      break;

    case 'system':
      appendSysMsg(ev.text || '');
      break;

    case 'model_changed':
      S.currentModel = ev.model || '';
      const lbl = document.getElementById('active-model-lbl');
      if (lbl) lbl.textContent = S.currentModel;
      const ctxM = document.getElementById('ctx-model');
      if (ctxM) ctxM.textContent = S.currentModel;
      appendSysMsg('Model switched to ' + S.currentModel);
      break;

    case 'error':
      setPresence('');
      if (S.streamEl) finaliseStreaming();
      appendSysMsg('Error: ' + (ev.text || ev.message || 'unknown error'));
      break;

    case 'agent_done':
      setPresence('');
      appendSysMsg('[Agent ' + (ev.name || '') + ' finished]');
      loadHelpers();
      break;

    case 'text':
      if (ev.text) {
        if (S.streaming && S.streamEl) {
          S.streamBuf += ev.text;
          S.streamEl.textContent = S.streamBuf;
          scrollBottom();
        } else {
          appendAthenaMsg(ev.text);
        }
      }
      break;
  }
}

// ── Scroll ───────────────────────────────────────────────────────
function scrollBottom() {
  const t = document.getElementById('thread');
  if (t) t.scrollTop = t.scrollHeight;
}

// ── Send message ─────────────────────────────────────────────────
async function send(text) {
  if (!text || !text.trim()) return;
  appendUserMsg(text);
  setPresence('thinking');
  try {
    await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
  } catch(e) {
    appendSysMsg('Send failed: ' + e.message);
    setPresence('');
  }
}

// ── Composer ─────────────────────────────────────────────────────
const input = document.getElementById('composer-input');
const sendBtn = document.getElementById('send-btn');

function autoResize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
}
input.addEventListener('input', autoResize);
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const v = input.value.trim();
    if (v) { send(v); input.value = ''; autoResize(); }
  }
});
sendBtn.addEventListener('click', () => {
  const v = input.value.trim();
  if (v) { send(v); input.value = ''; autoResize(); }
});

// ── Stop ─────────────────────────────────────────────────────────
document.getElementById('stop-btn').addEventListener('click', async () => {
  try { await fetch('/stop', { method: 'POST' }); } catch {}
  setPresence('');
});

// ── Clear ─────────────────────────────────────────────────────────
document.getElementById('clear-btn').addEventListener('click', async () => {
  if (!confirm('Clear conversation context?')) return;
  try { await fetch('/clear', { method: 'POST' }); } catch {}
  thread.innerHTML = '';
  S.toolsUsed = 0; S.curTier = 0;
  if (CTX_TOOLS) CTX_TOOLS.textContent = '0 tools used';
  if (CTX_TIER) CTX_TIER.textContent = 'tier 0 autonomy';
  appendSysMsg('Context cleared.');
});
document.getElementById('forget-btn')?.addEventListener('click', async () => {
  if (!confirm('Forget this session context?')) return;
  try { await fetch('/clear', { method: 'POST' }); } catch {}
  appendSysMsg('Session context cleared.');
});

// ── Model selector ───────────────────────────────────────────────
async function loadModels() {
  try {
    const r = await fetch('/models');
    const data = await r.json();
    S.models = data.models || (data.groups || []).flatMap(g => g.models || []);
    S.currentModel = data.active || data.current || '';
    ['model-select', 'model-select-inline', 'settings-model-select'].forEach(id => {
      const sel = document.getElementById(id);
      if (!sel) return;
      sel.innerHTML = '';
      S.models.forEach(m => {
        const o = document.createElement('option');
        o.value = m; o.textContent = m;
        if (m === S.currentModel) o.selected = true;
        sel.appendChild(o);
      });
    });
    const lbl = document.getElementById('active-model-lbl');
    if (lbl) lbl.textContent = S.currentModel;
    const ctxM = document.getElementById('ctx-model');
    if (ctxM) ctxM.textContent = S.currentModel;
  } catch {}
}
async function switchModel(m) {
  try {
    await fetch('/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m })
    });
    S.currentModel = m;
    const lbl = document.getElementById('active-model-lbl');
    if (lbl) lbl.textContent = m;
    const ctxM = document.getElementById('ctx-model');
    if (ctxM) ctxM.textContent = m;
    appendSysMsg('Switched to ' + m);
  } catch {}
}
['model-select', 'model-select-inline', 'settings-model-select'].forEach(id => {
  document.getElementById(id)?.addEventListener('change', e => switchModel(e.target.value));
});
document.getElementById('model-switch-btn')?.addEventListener('click', () => {
  const sel = document.getElementById('model-select-inline');
  if (!sel) return;
  sel.style.display = sel.style.display === 'none' ? '' : 'none';
});

// ── Dashboard data ───────────────────────────────────────────────
async function loadDash() {
  try {
    const r = await fetch('/machine');
    const m = await r.json();
    const el = id => document.getElementById(id);
    if (el('dash-os')) el('dash-os').textContent = m.os || '--';
    if (el('dash-cpu')) el('dash-cpu').textContent = m.cpu || '--';
    if (el('dash-ram')) el('dash-ram').textContent = m.ram || '--';
    if (el('dash-disk')) el('dash-disk').textContent = m.disk || '--';
    const name = m.hostname || '${N}';
    if (el('dash-greeting')) el('dash-greeting').textContent = 'Watching over ' + name + '.';
    if (el('dash-summary')) el('dash-summary').textContent = m.summary || 'All systems nominal.';
    if (el('machine-chip')) el('machine-chip').textContent = name;
  } catch {}
  try {
    const r = await fetch('/skills');
    const data = await r.json();
    const skills = data.skills || [];
    if (document.getElementById('stat-skills'))
      document.getElementById('stat-skills').textContent = skills.length;
    if (document.getElementById('badge-skills'))
      document.getElementById('badge-skills').textContent = skills.length;
    const grid = document.getElementById('dash-skills-grid');
    if (grid) {
      grid.innerHTML = skills.slice(0, 12).map(s =>
        '<div class="skill-chip ' + (s.status === 'verified' ? 'verified' : 'unverified') + '">' +
        '<span class="sc-ico">' + (s.status === 'verified' ? '&#10003;' : '&#8285;') + '</span>' +
        '<div><b>' + esc(s.name) + '</b><span>' + esc(s.desc || '') + '</span></div>' +
        '</div>'
      ).join('');
    }
  } catch {}
  try {
    const r = await fetch('/memory');
    const data = await r.json();
    const entries = data.entries || [];
    if (document.getElementById('stat-memory'))
      document.getElementById('stat-memory').textContent = entries.length;
    if (document.getElementById('badge-memory'))
      document.getElementById('badge-memory').textContent = entries.length;
    if (document.getElementById('dash-mem-count'))
      document.getElementById('dash-mem-count').textContent = entries.length;
    const pct = Math.min(100, Math.round(entries.length / 50 * 100));
    if (document.getElementById('mem-pct'))
      document.getElementById('mem-pct').textContent = pct + '%';
    if (document.getElementById('mem-bar'))
      document.getElementById('mem-bar').style.width = pct + '%';
  } catch {}
}

// ── Memory view ──────────────────────────────────────────────────
async function loadMemory() {
  try {
    const r = await fetch('/memory');
    const data = await r.json();
    const entries = data.entries || [];
    const eyebrow = document.getElementById('mem-view-eyebrow');
    if (eyebrow) eyebrow.textContent = entries.length + ' entries';
    const grid = document.getElementById('mem-view-grid');
    if (grid) {
      if (!entries.length) {
        grid.innerHTML = '<div style="color:var(--ink-3);padding:20px 0">No memories yet.</div>';
        return;
      }
      grid.innerHTML = entries.map((e, i) =>
        '<div class="mem-card">' +
        '<div class="mc-idx">' + (i+1) + '</div>' +
        '<div class="mc-body">' + fmt(esc(typeof e === 'string' ? e : e.text || JSON.stringify(e))) + '</div>' +
        '</div>'
      ).join('');
    }
  } catch(e) {
    const grid = document.getElementById('mem-view-grid');
    if (grid) grid.innerHTML = '<div style="color:var(--ink-3)">Failed to load.</div>';
  }
}

// ── Skills view ──────────────────────────────────────────────────
async function loadSkills() {
  try {
    const r = await fetch('/skills');
    const data = await r.json();
    const skills = data.skills || [];
    const chip = document.getElementById('skills-chip');
    if (chip) chip.innerHTML = '<span class="dot"></span>' + skills.length + ' skills';
    const grid = document.getElementById('skills-view-grid');
    if (grid) {
      if (!skills.length) {
        grid.innerHTML = '<div style="color:var(--ink-3);padding:20px 0">No skills yet. ${N} builds skills automatically as she learns.</div>';
        return;
      }
      grid.innerHTML = skills.map(s =>
        '<div class="skill-chip ' + (s.status === 'verified' ? 'verified' : 'unverified') + '">' +
        '<span class="sc-ico">' + (s.status === 'verified' ? '&#10003;' : '&#8285;') + '</span>' +
        '<div><b>' + esc(s.name) + '</b><span>' + esc(s.desc || '') + '</span></div>' +
        '<span class="sc-status">' + esc(s.status || 'unknown') + '</span>' +
        '</div>'
      ).join('');
    }
  } catch {}
}

// ── Agents view ──────────────────────────────────────────────────
async function loadAgentsView() {
  try {
    const r = await fetch('/agents');
    const data = await r.json();
    const agents = data.agents || [];
    if (document.getElementById('badge-agents'))
      document.getElementById('badge-agents').textContent = agents.length;
    if (document.getElementById('helpers-count'))
      document.getElementById('helpers-count').textContent = agents.length + ' agent' + (agents.length===1?'':'s');
    const grid = document.getElementById('agents-view-grid');
    if (grid) {
      if (!agents.length) {
        grid.innerHTML = '<div style="color:var(--ink-3);padding:20px 0">No agents yet this session.</div>';
      } else {
        grid.innerHTML = agents.map(a =>
          '<div class="skill-chip ' + (a.done ? 'verified' : 'unverified') + '">' +
          '<span class="sc-ico">' + (a.done ? '&#10003;' : '<span class="doing-dot"></span>') + '</span>' +
          '<div><b>' + esc(a.name || 'helper') + '</b><span>' + esc(a.task || '') + '</span></div>' +
          '</div>'
        ).join('');
      }
    }
    // helpers in ctx sidebar
    loadHelpers(agents);
  } catch {}
  // Load CORAL log
  try {
    const cr = await fetch('/coral');
    const cdata = await cr.json();
    const cEntries = cdata.entries || [];
    const cVersion = cdata.version || 0;
    const vEl = document.getElementById('coral-version');
    if (vEl) vEl.textContent = 'v' + cVersion;
    const feed = document.getElementById('coral-feed');
    if (feed) {
      if (!cEntries.length) {
        feed.innerHTML = '<div class="coral-row"><span class="cv">--</span><span class="cdot" style="background:var(--ink-3)"></span><span class="ctext">No CORAL entries yet.</span></div>';
      } else {
        feed.innerHTML = cEntries.slice(-20).reverse().map(e => {
          const col = e.platform === 'win32' ? 'var(--olive)' : e.platform === 'darwin' ? 'var(--bronze)' : 'var(--lapis)';
          return '<div class="coral-row"><span class="cv">v' + esc(String(e.version || '--')) + '</span>' +
            '<span class="cdot" style="background:' + col + '"></span>' +
            '<span class="ctext">' + esc(e.skill || e.type || '') + ' -- ' + esc((e.summary || e.desc || '').slice(0, 80)) + '</span></div>';
        }).join('');
      }
    }
  } catch {}
}

async function loadHelpers(agents) {
  if (!agents) {
    try { const r = await fetch('/agents'); agents = (await r.json()).agents || []; } catch { agents = []; }
  }
  const list = document.getElementById('helpers-list');
  const count = document.getElementById('helpers-count');
  if (count) count.textContent = agents.length + ' agent' + (agents.length===1?'':'s');
  if (list) {
    const active = agents.filter(a => !a.done);
    if (!active.length) {
      list.innerHTML = '<div style="font-size:12px;color:var(--ink-3);padding:8px 0">No agents running.</div>' +
        '<button class="add-agent" id="spawn-agent-btn"><svg width="14" height="14"><use href="#i-plus"/></svg>Send out a helper</button>';
    } else {
      list.innerHTML = active.map(a =>
        '<div class="watch-row">' +
        '<div class="watch-ico bg-lapis"><span class="doing-dot"></span></div>' +
        '<div class="watch-info"><b>' + esc(a.name || 'helper') + '</b><span>' + esc(a.task || 'running') + '</span></div>' +
        '</div>'
      ).join('') +
      '<button class="add-agent" id="spawn-agent-btn"><svg width="14" height="14"><use href="#i-plus"/></svg>Send out a helper</button>';
    }
  }
}

// ── Sessions view ────────────────────────────────────────────────
async function loadSessions() {
  const list = document.getElementById('sessions-list');
  try {
    const r = await fetch('/sessions');
    const data = await r.json();
    const sessions = data.sessions || [];
    if (!list) return;
    if (!sessions.length) {
      list.innerHTML = '<div class="session-row"><span class="when">--</span><span class="what">No sessions recorded yet.</span><span class="tools"></span></div>';
      return;
    }
    list.innerHTML = sessions.map(s =>
      '<div class="session-row">' +
      '<span class="when">' + esc(s.when || '--') + '</span>' +
      '<span class="what">' + esc(s.what || '') + '</span>' +
      '<span class="tools">' + (s.tools ? s.tools + ' tools' : '') + '</span>' +
      '</div>'
    ).join('');
  } catch {
    if (list) list.innerHTML = '<div class="session-row"><span class="when">--</span><span class="what">Could not load sessions.</span><span class="tools"></span></div>';
  }
}

// ── Spawn agent ──────────────────────────────────────────────────
async function spawnAgent() {
  const goal = prompt('What should the helper do?');
  if (!goal) return;
  try {
    await fetch('/spawn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: goal })
    });
    appendSysMsg('Spawned helper: ' + goal);
    loadHelpers();
  } catch(e) {
    appendSysMsg('Spawn failed: ' + e.message);
  }
}
document.addEventListener('click', e => {
  if (e.target.closest('#spawn-agent-btn') || e.target.closest('#agents-spawn-btn')) spawnAgent();
});

// ── Init ─────────────────────────────────────────────────────────
loadModels();
connectSSE();
setPresence('');

})();
</script>`;
}


// -- serveUI --
export async function serveUI(messages) {
  const agentName = NAME || 'Athena';
  const port = await getFreePort();
  process.env.ATHENA_UI = '1';

  const HTML = buildHTML(agentName) + '\n' + buildScript(agentName) + '\n</body>\n</html>';

  function resetMessages(arr) {
    arr.length = 0;
    arr.push({ role: 'system', content: systemPrompt() });
  }

  let agentFns = null;
  async function getAgentFns() {
    if (!agentFns) {
      const { spawnAgent, listAgents } = await import('./agents.mjs');
      agentFns = { spawnAgent, listAgents };
    }
    return agentFns;
  }

  // Input queue -- chat route pushes here; main loop pulls
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

  const server = createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    const method = req.method.toUpperCase();

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (url === '/styles/athena.css') {
      try {
        const css = readFileSync(CSS_PATH, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(css);
      } catch { res.writeHead(404); res.end('/* css not found */'); }
      return;
    }

    if (url === '/' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(HTML); return;
    }

    if (url === '/events' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(':\n\n');
      sseClients.add(res);
      for (const ev of _bootBuffer) {
        try { res.write('data: ' + JSON.stringify(ev) + '\n\n'); } catch {}
      }
      _bootBuffer.length = 0;
      for (const txt of _bootInputQueue) pushInput(txt);
      _bootInputQueue.length = 0;
      req.on('close', () => { sseClients.delete(res); if (sseClients.size === 0) setInterrupt(); });
      return;
    }

    if (url === '/chat' && method === 'POST') {
      const body = await readBody(req, res); if (body === null) return;
      const data = parseJSON(body, res); if (data === null) return;
      const { text } = data;
      if (!text || typeof text !== 'string' || !text.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"text required"}'); return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
      pushInput(text.trim()); return;
    }

    if (url === '/spawn' && method === 'POST') {
      const body = await readBody(req, res); if (body === null) return;
      const data = parseJSON(body, res); if (data === null) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const goal = (data.goal || data.task || '').trim();
      const name = (data.name || 'helper').trim();
      if (!goal) { res.end('{"error":"goal required"}'); return; }
      const { spawnAgent } = await getAgentFns();
      const agentId = spawnAgent(name, goal, uiEmit);
      res.end(JSON.stringify({ agentId })); return;
    }

    if (url === '/agents' && method === 'GET') {
      const { listAgents } = await getAgentFns();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(listAgents())); return;
    }

    if (url === '/models' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ groups: CURATED_MODELS, active: state.activeModel, models: CURATED_MODELS.flatMap(g => g.models || [g]) })); return;
    }

    if (url === '/model' && method === 'POST') {
      const body = await readBody(req, res); if (body === null) return;
      const data = parseJSON(body, res); if (data === null) return;
      const { model } = data; if (model) state.activeModel = model;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ active: state.activeModel }));
      broadcast({ type: 'model_changed', model: state.activeModel }); return;
    }

    if (url === '/stop' && method === 'POST') {
      setInterrupt();
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return;
    }

    if (url === '/clear' && method === 'POST') {
      resetMessages(messages);
      res.writeHead(200); res.end(); return;
    }

    if (url === '/memory' && method === 'GET') {
      try {
        const toItems = f => readEntries(f).map(content => ({ type: 'memory', content }));
        const entries = [...toItems(PATHS.agentMem), ...toItems(PATHS.userMem)];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ entries }));
      } catch { res.writeHead(200); res.end('{"entries":[]}'); }
      return;
    }

    if (url === '/skills' && method === 'GET') {
      try {
        const { scanSkills } = await import('./skills.mjs');
        const raw = scanSkills();
        const skills = (raw || []).map(s => {
          const name = s.dir || s.name || 'unknown';
          const desc = s.desc || s.description || '';
          // Read status from SKILL.md frontmatter
          let status = 'unverified';
          try {
            const mdPath = join(PATHS.skills, name, 'SKILL.md');
            const content = readFileSync(mdPath, 'utf8');
            const m = content.match(/^status:\s*(.+)$/m);
            if (m) status = m[1].trim();
          } catch {}
          return { name, desc, status };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ skills }));
      } catch (e) {
        console.error('[ui:/skills]', e.message);
        res.writeHead(200); res.end('{"skills":[]}');
      }
      return;
    }

    if (url === '/sessions' && method === 'GET') {
      try {
        let sessions = [];
        if (existsSync(PATHS.summary)) {
          const raw = readFileSync(PATHS.summary, 'utf8').trim();
          if (raw) {
            sessions = raw.split(/\n(?=\[)/).filter(e => e.trim()).slice(-20).reverse().map(e => {
              const dateMatch = e.match(/^\[([^\]]+)\]/);
              const toolMatch = e.match(/tools used:\s*(\d+)/i);
              return {
                when: dateMatch ? dateMatch[1] : '--',
                what: e.replace(/^\[[^\]]+\]\s*/, '').split('\n')[0].slice(0, 120),
                tools: toolMatch ? toolMatch[1] : '',
              };
            });
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sessions }));
      } catch { res.writeHead(200); res.end('{"sessions":[]}'); }
      return;
    }

    if (url === '/coral' && method === 'GET') {
      try {
        const { getCoralLog, getCoralVersion } = await import('./agents.mjs');
        const entries = typeof getCoralLog === 'function' ? getCoralLog(0) : [];
        const version = typeof getCoralVersion === 'function' ? getCoralVersion() : 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ entries, version }));
      } catch { res.writeHead(200); res.end('{"entries":[],"version":0}'); }
      return;
    }

    if (url === '/machine' && method === 'GET') {
      try {
        const { loadFingerprint } = await import('./machines.mjs');
        const fp = loadFingerprint();
        const sys = fp?.caps?.system || {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          hostname: sys.hostname || 'local',
          os: sys.platform || '--',
          cpu: (sys.cpuModel || '--').slice(0, 40),
          ram: sys.ramTotal || '--',
          disk: sys.disks?.[0] || '--',
          summary: fp ? 'Machine profiled ' + (fp.capturedAt ? new Date(fp.capturedAt).toLocaleDateString() : '') : 'Not yet profiled.',
        }));
      } catch {
        const os = await import('node:os');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          hostname: os.hostname(),
          os: os.type() + ' ' + os.release(),
          cpu: (os.cpus()[0]?.model || '--').slice(0, 40),
          ram: Math.round(os.totalmem() / 1024 / 1024 / 1024) + ' GB',
          disk: '--',
          summary: 'Running on ' + os.hostname(),
        }));
      }
      return;
    }

    res.writeHead(404); res.end();
  });

  server.listen(port, '127.0.0.1', () => {
    const url = 'http://127.0.0.1:' + port;
    console.log('\n  ' + agentName + ' -> ' + url + '\n');
    const open = process.platform === 'darwin' ? 'open "' + url + '"'
      : process.platform === 'win32' ? 'start "" "' + url + '"'
      : 'xdg-open "' + url + '" 2>/dev/null &';
    exec(open, () => {});
  });

  // Wire model auto-switch broadcast to UI
  setModelSwitchCallback(model => {
    broadcast({ type: 'model_changed', model });
  });

  setRequestUserInput(async (question, choices) => {
    broadcast({ type: 'clarify', question, choices: choices || [] });
    return nextInput();
  });

  // Main chat loop -- waits for input, runs turn(), repeat
  while (true) {
    const inp = await nextInput();
    if (!inp) continue;

    if (inp === '/instincts') {
      const raw = existsSync(PATHS.instincts) ? readFileSync(PATHS.instincts, 'utf8').trim() : '';
      const entries = raw ? raw.split('\x15').map(e => e.trim()).filter(Boolean) : [];
      const { scanForInstincts } = await import('./memory.mjs');
      const candidates = scanForInstincts(5);
      const lines = ['INSTINCTS (' + entries.length + ' active):', ...entries.map((e,i) => '  '+(i+1)+'. '+e)];
      if (candidates.length) { lines.push('', 'CANDIDATES:'); candidates.forEach(c => lines.push('  '+c.tool+' used '+c.count+'x')); }
      broadcast({ type: 'system', text: lines.join('\n') }); broadcast({ type: 'done' }); continue;
    }
    if (inp === '/reload') {
      if (messages.length > 0 && messages[0].role === 'system') messages[0].content = systemPrompt();
      broadcast({ type: 'system', text: 'System prompt reloaded.' }); broadcast({ type: 'done' }); continue;
    }
    if (inp === '/forget') {
      resetMessages(messages);
      messages.push({ role: 'user', content: '[system] Context cleared. Acknowledge briefly.' });
      messages.push({ role: 'assistant', content: 'Context cleared. Memory files intact. What do you need?' });
      broadcast({ type: 'system', text: 'Context cleared.' }); broadcast({ type: 'done' }); continue;
    }
    if (inp === '/mem') {
      const m = existsSync(PATHS.agentMem) ? readFileSync(PATHS.agentMem, 'utf8') : '(empty)';
      broadcast({ type: 'system', text: m }); broadcast({ type: 'done' }); continue;
    }
    if (inp === '/status') {
      const { MEM_CHAR_LIMIT } = await import('./config.mjs');
      const memChars = existsSync(PATHS.agentMem) ? readFileSync(PATHS.agentMem, 'utf8').length : 0;
      const memPct = Math.round(memChars / MEM_CHAR_LIMIT * 100);
      const turns = messages.filter(m => m.role === 'user').length;
      broadcast({ type: 'system', text: '  model:  ' + state.activeModel + '\n  turns:  ' + turns + '\n  memory: ' + memPct + '%' });
      broadcast({ type: 'done' }); continue;
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
        spawnAgent(name, goal, uiEmit);
        broadcast({ type: 'system', text: 'Agent "' + name + '" spawned.' });
      }
      broadcast({ type: 'done' }); continue;
    }
    if (inp === '/agents') {
      const { listAgents } = await getAgentFns();
      const agents = listAgents();
      const lines = agents.length ? agents.map(a => (a.status==='done'?'v ':'. ') + a.name + '  ' + (a.goal||'').slice(0,60)) : ['(no agents this session)'];
      broadcast({ type: 'system', text: lines.join('\n') }); broadcast({ type: 'done' }); continue;
    }

    messages.push({ role: 'user', content: inp });
    try { await turn(messages, uiEmit); }
    catch (e) { broadcast({ type: 'error', message: e.message }); broadcast({ type: 'done' }); }
  }
}
