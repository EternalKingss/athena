#!/usr/bin/env node
// ATHENA — portable AI agent. Lives on a drive, runs on any machine.
// v4.0: modular architecture, Athena personality, self-building skills, web browsing.
// Zero npm dependencies — only Node built-ins.

import * as readline from 'node:readline/promises';
import { existsSync, readFileSync } from 'node:fs';

import { NAME, MODEL, state } from './config.mjs';
import { PATHS } from './paths.mjs';
import { systemPrompt } from './personality.mjs';
import { saveAndSummarize } from './memory.mjs';
import { turn, runTask, setRequestUserInput, freshMessages, setInterrupt, isActive } from './core.mjs';
import { serveUI, uiEmit } from './ui.mjs';
import { setAgentFunctions } from './tools.mjs';
import { spawnAgent, listAgents, workspaceRead, workspaceWrite } from './agents.mjs';
import { detectCapabilities } from './capabilities.mjs';

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
  const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => rl.question(q);

  let closing = false;
  const close = async () => {
    if (closing) return; closing = true;
    console.log('');
    await saveAndSummarize(messages);
    rl.close();
    process.exit(0);
  };
  process.on('SIGINT', () => {
    if (isActive()) {
      setInterrupt();
      process.stdout.write(dim('\n  [interrupted — generating summary…]\n'));
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
        console.log(dim('  [interrupting — will summarise when current tool finishes]\n'));
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
      messages.push({ role: 'system', content: systemPrompt() });
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
      try { await runTask(goal, messages, cliEmit); } catch (e) { console.log(`\n  error: ${e.message}\n`); }
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
      console.log(cyan(`  Agent "${name}" spawned (${id}) — running in background\n`));
      continue;
    }

    // /agents — list pool
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
    try { await turn(messages, cliEmit); } catch (e) { console.log(`\n  error: ${e.message}\n`); }
  }
}

// ---- Entry point ----
// Fire capability detection in the background — HDD-friendly, non-blocking.
// capabilitiesSummary() returns '' until the cache populates, so turn 1 omits
// the machine block. It appears automatically once the scan resolves (usually
// before the first response is sent).
detectCapabilities().catch(() => {});

if (UI_MODE) {
  _globalEmit = uiEmit;
  const messages = freshMessages();
  process.on('SIGINT', async () => { await saveAndSummarize(messages); process.exit(0); });
  await serveUI(messages);
} else {
  await runCLI();
}
