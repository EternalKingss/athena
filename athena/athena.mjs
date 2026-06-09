#!/usr/bin/env node
// ATHENA -- portable AI agent. Lives on a drive, runs on any machine.
// v3.1: offline-first architecture -- L2 Control Engine (zero dependencies), L3 local LLM, full cloud fallback.
// Zero npm dependencies -- only Node built-ins.

import * as readline from 'node:readline/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

import { NAME, MODEL, state, _hasKey, LOCAL_LLM_PORT, isOfflineMode, registerLocalModel } from './config.mjs';
import { PATHS } from './paths.mjs';
import { systemPrompt, offlineSystemPrompt } from './personality.mjs';
import { saveAndSummarize, pruneOldSessions } from './memory.mjs';
import { turn, runTask, setRequestUserInput, freshMessages, setInterrupt, isActive, turnWithFallback } from './core.mjs';
import { serveUI, uiEmit, queueBootInput } from './ui.mjs';
import { setAgentFunctions } from './tools.mjs';
import { spawnAgent, listAgents, workspaceRead, workspaceWrite } from './agents.mjs';
import { detectCapabilities, getCachedCapabilities } from './capabilities.mjs';
import { checkMachineReturn, saveFingerprint } from './machines.mjs';
import { logAuditEvent } from './audit.mjs';

import { detectLocalModel, startLocalLLM, stopLocalLLM, getLocalModelName } from './local_llm.mjs';

const UI_MODE = process.argv.includes('--ui');

// ---- Wire agent functions into tools (breaks circular dependency) ----
// globalEmit is set per-mode below, so we wrap lazily via the closure.
let _globalEmit = null;
setAgentFunctions({
  spawnAgent: (name, goal) => spawnAgent(name, goal, ev => _globalEmit?.(ev)),
  listAgents,
  workspaceRead,
  workspaceWrite,
});

// ---- Terminal helpers (CLI only) ----
const bold = s => `\x1b[1m${s}\x1b[0m`;
const dim  = s => `\x1b[2m${s}\x1b[0m`;
const cyan = s => `\x1b[36m${s}\x1b[0m`;

// ---- CLI emit ----
function cliEmit(event) {
  const prefix = event.agentName ? dim(`  [${event.agentName}] `) : '';
  if (event.type === 'token')        process.stdout.write(event.content);
  if (event.type === 'stream_start') process.stdout.write('\n');
  if (event.type === 'stream_end')   process.stdout.write('\n');
  if (event.type === 'tool_start')   process.stdout.write(dim(`\n${prefix}[${event.name}] ${JSON.stringify(event.args||{}).slice(0,80)}…\n`));
  if (event.type === 'tool_result')  process.stdout.write(dim(`${prefix}→ ${String(event.result||'').split('\n')[0].slice(0,100)}\n`));
  if (event.type === 'system')       process.stdout.write(dim(`\n${prefix}${event.text}\n`));
  if (event.type === 'agent_done')   process.stdout.write(cyan(`\n  ✓ Agent "${event.agentName}" finished (${event.status})\n`));
  if (event.type === 'done' && !event.agentId) process.stdout.write('\n');
}

// ---- CLI runner ----
async function runCLI() {
  console.clear();
  console.log(bold(`\n  ${NAME}`) + dim(`  ·  ${state.activeModel}  ·  ${process.platform}/${process.arch}`));
  console.log(dim(`  /exit  /task <goal>  /spawn <name> <goal>  /agents  /model [name]  /mem  /forget  /help\n`));

  _globalEmit = cliEmit;

  const messages = freshMessages();
  _activeMessages = messages;

  // Readline with history -- arrow keys cycle through previous inputs
  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 100,
  });
  const ask = q => rl.question(q);

  // Prune old session files in the background -- non-blocking
  pruneOldSessions().catch(() => {});

  // Inform user of intelligence tier if no LLM configured
  if (!_hasKey && !detectLocalModel()) {
    console.log(dim([
      '',
      '  [L2 mode] Running on Control Engine only -- no AI model configured.',
      '  For AI:  add OPENAI_API_KEY or ANTHROPIC_API_KEY to config/.env',
      '  Offline: run runtime/get-offline.sh  (~2.2 GB download)',
      '',
    ].join('\n')));
  }

  let closing = false;
  const close = async () => {
    if (closing) return; closing = true;
    console.log('');
    await stopLocalLLM().catch(() => {});
    await saveAndSummarize(messages);
    const caps = getCachedCapabilities();
    if (caps) await Promise.all([saveFingerprint(caps), logAuditEvent('session_end')]).catch(() => {});
    rl.close();
    process.exit(0);
  };
  process.on('SIGINT', () => {
    if (isActive()) {
      setInterrupt();
      process.stdout.write(dim('\n  [interrupted -- generating summary…]\n'));
    } else {
      close();
    }
  });

  setRequestUserInput(async (question, choices) => {
    console.log(`\n  ${bold('?')} ${question}`);
    if (choices.length) choices.forEach((c, i) => console.log(dim(`    ${i + 1}. ${c}`)));
    const raw = await ask(dim('  answer: '));
    const num = parseInt(raw.trim());
    if (choices.length && num >= 1 && num <= choices.length) return choices[num - 1];
    return raw.trim();
  });

  while (true) {
    let input;
    try { input = (await ask(bold('you') + ': ')).trim(); } catch { await close(); break; }
    if (!input) continue;

    if (input === '/exit' || input === '/quit') { await close(); break; }

    if (input === '/stop') {
      if (isActive()) {
        setInterrupt();
        console.log(dim('  [interrupting -- will summarise when current tool finishes]\n'));
      } else {
        console.log(dim('  nothing running\n'));
      }
      continue;
    }

    if (input === '/help') {
      console.log(dim([
        '',
        '  /task <goal>          autonomous multi-step task',
        '  /spawn <name> <goal>  spawn a background agent in parallel',
        '  /agents               list all running/done agents',
        '  /model [name]         show or switch active model',
        '  /mem                  show long-term memory',
        '  /forget               clear current context',
        '  /stop                 interrupt current task, get summary',
        '  /exit                 save session + quit',
        '',
      ].join('\n')));
      continue;
    }

    if (input === '/mem') {
      console.log('\n' + (existsSync(PATHS.agentMem) ? readFileSync(PATHS.agentMem, 'utf8') : '(empty)') + '\n');
      continue;
    }

    if (input === '/forget') {
      messages.length = 0;
      messages.push({ role: 'system', content: isOfflineMode() ? offlineSystemPrompt() : systemPrompt() });
      messages.push({ role: 'user', content: '[system] Context cleared. Long-term memory files intact. Session conversation history is gone.' });
      messages.push({ role: 'assistant', content: 'Got it. Context cleared. Memory files intact. What now?' });
      console.log(dim('  context cleared\n')); continue;
    }

    if (input.startsWith('/model')) {
      const m = input.slice(6).trim();
      if (!m) { console.log(dim(`  active: ${state.activeModel}\n`)); continue; }
      state.activeModel = m;
      console.log(dim(`  switched to ${state.activeModel}\n`)); continue;
    }

    if (input.startsWith('/task ')) {
      const goal = input.slice(6).trim();
      if (!goal) { console.log(dim('  usage: /task <goal>\n')); continue; }
      try { await runTask(goal, messages, cliEmit, turnWithFallback); } catch (e) { console.log(`\n  error: ${e.message}\n`); }
      continue;
    }

    // /spawn <name> <rest-of-line-is-goal>
    if (input.startsWith('/spawn ')) {
      const rest = input.slice(7).trim();
      const spaceIdx = rest.indexOf(' ');
      if (spaceIdx === -1) { console.log(dim('  usage: /spawn <name> <goal>\n')); continue; }
      const name = rest.slice(0, spaceIdx).trim();
      const goal = rest.slice(spaceIdx + 1).trim();
      const id = spawnAgent(name, goal, cliEmit);
      console.log(cyan(`  Agent "${name}" spawned (${id}) -- running in background\n`));
      continue;
    }

    // /agents -- list pool
    if (input === '/agents') {
      const agents = listAgents();
      if (!agents.length) { console.log(dim('  no agents running\n')); continue; }
      console.log('');
      for (const a of agents) {
        const icon = a.status === 'running' ? '⟳' : a.status === 'done' ? '✓' : '✗';
        console.log(`  ${icon} ${bold(a.name)} (${a.id})  ${dim(a.status)}  ${dim(a.goal.slice(0, 60))}`);
      }
      console.log('');
      continue;
    }

    messages.push({ role: 'user', content: input });
    try { await turnWithFallback(messages, cliEmit); } catch (e) { console.log(`\n  error: ${e.message}\n`); }
    // Auto-save after every turn so crashes/kills don't lose the session
    saveAndSummarize(messages).catch(() => {});
  }
}

// ---- Entry point ----
// ---- Local LLM startup (non-blocking -- L2 is always available immediately) ----
{
  const modelPath = detectLocalModel();
  if (modelPath) {
    const modelId = getLocalModelName() || ('local-' + modelPath.split('/').pop().replace(/\.gguf$/i, '').toLowerCase().replace(/[\s_.]+/g, '-'));
    registerLocalModel(modelId);
    // Fire and forget -- Athena is immediately usable at L2 while LLM loads in background
    const emit = ev => { if (_globalEmit) _globalEmit(ev); };
    startLocalLLM(LOCAL_LLM_PORT, emit).catch(() => {});
  } else if (!_hasKey) {
    // No cloud key AND no local model -- Control Engine (L2) only mode
    // Will be printed once CLI is ready
  }
}

// Fire capability detection in the background -- HDD-friendly, non-blocking.
// All boot intelligence runs in this .then() so the UI is immediately responsive.
let _activeMessages = null;
detectCapabilities()
  .then(async caps => {
    // Backfill system prompt with fresh machine data
    if (_activeMessages?.[0]?.role === 'system') _activeMessages[0].content = isOfflineMode() ? offlineSystemPrompt() : systemPrompt();

    // Auto-greet: make Athena speak on startup without being asked.
    // Only run full boot_triage when it hasn't run in the last 6 hours -- otherwise
    // just greet from memory so every session doesn't feel like a first-time setup.
    const SIX_HOURS_MS  = 6 * 60 * 60 * 1000;
    const { loadFingerprint } = await import('./machines.mjs');
    const fp              = loadFingerprint();
    const lastChecked     = fp?.capturedAt ? Date.now() - new Date(fp.capturedAt).getTime() : Infinity;
    const needsFullTriage = lastChecked > SIX_HOURS_MS;

    // Only auto-greet when a full triage is needed (>6h since last check).
    // For recent checks: just print a static status line in CLI, or stay silent in UI.
    // This prevents every session creating a trivial "hey" summary entry.
    if (needsFullTriage) {
      const _bootAgo = (() => {
        if (!fp || !fp.capturedAt) return null;
        const ms = Date.now() - new Date(fp.capturedAt).getTime();
        const d = Math.floor(ms / 86400000);
        const h = Math.floor(ms / 3600000);
        return d > 0 ? d + 'd' : h > 0 ? h + 'h' : 'recently';
      })();
      const _bootCtx = _bootAgo
        ? 'Last seen ' + _bootAgo + ' ago on this machine.'
        : 'First visit on this machine.';
      const _sessCount = (() => { try { return readdirSync(PATHS.sessDir).filter(f => f.endsWith('.jsonl') && f !== '.gitkeep').length; } catch { return 0; } })();
      const _sessNote  = _sessCount > 1 ? ' Session ' + _sessCount + ' with this user.' : ' First session on this drive.';
      const _diffInstruction = _bootAgo ? ' Also run machine_diff to show what changed since last visit.' : '';
      const bootMsg = '[auto-boot] ' + _bootCtx + _sessNote + ' Run boot_triage and machine_info.' + _diffInstruction + ' Greet with a sharp status report -- what you found, what matters, what to watch. No fluff.';
      if (UI_MODE) {
        queueBootInput(bootMsg);
      } else if (_activeMessages?.length === 1 && _globalEmit && !isActive()) {
        _activeMessages.push({ role: 'user', content: bootMsg });
        await turn(_activeMessages, _globalEmit).catch(() => {});
      }
    } else {
      // Recent check -- skip LLM boot. CLI: quiet status line. UI: buffered system msg.
      const { loadFingerprint: lf } = await import('./machines.mjs');
      const fp2 = lf();
      const _recentAgo = fp2?.capturedAt
        ? (() => {
            const ms = Date.now() - new Date(fp2.capturedAt).getTime();
            const h = Math.floor(ms / 3600000);
            return h < 1 ? 'just now' : h + 'h ago';
          })()
        : 'unknown';
      if (UI_MODE) {
        // Buffer the status -- will be delivered when browser connects via SSE drain
        uiEmit({ type: 'system', text: 'Triage ran ' + _recentAgo + ' -- ready.' });
        uiEmit({ type: 'done' });
      } else if (_globalEmit) {
        process.stdout.write(dim('  triage last ran ' + _recentAgo + ' -- type to start\n\n'));
      }
    }

    // Save fingerprint immediately so it's persisted even if session crashes later
    saveFingerprint(caps).catch(() => {});

    // Audit session start
    await logAuditEvent('session_start', { platform: process.platform, arch: process.arch, model: state.activeModel }).catch(() => {});
  })
  .catch(() => {});

if (UI_MODE) {
  _globalEmit = uiEmit;
  _activeMessages = freshMessages();

  // Prune old sessions in background on UI start
  pruneOldSessions().catch(() => {});

  const uiShutdown = async () => {
    await stopLocalLLM().catch(() => {});
    await saveAndSummarize(_activeMessages);
    const caps = getCachedCapabilities();
    if (caps) await Promise.all([saveFingerprint(caps), logAuditEvent('session_end')]).catch(() => {});
    process.exit(0);
  };
  // SIGINT = Ctrl-C, SIGTERM = tab close / process manager kill -- both save
  process.on('SIGINT',  uiShutdown);
  process.on('SIGTERM', uiShutdown);
  await serveUI(_activeMessages);
} else {
  await runCLI();
}
