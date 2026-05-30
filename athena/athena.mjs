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
import { turn, runTask, setRequestUserInput, freshMessages } from './core.mjs';
import { serveUI, uiEmit } from './ui.mjs';

const UI_MODE = process.argv.includes('--ui');

// ---- Terminal helpers (CLI only) ----
const bold = s => `\x1b[1m${s}\x1b[0m`;
const dim  = s => `\x1b[2m${s}\x1b[0m`;

// ---- CLI emit ----
function cliEmit(event) {
  if (event.type === 'token')   process.stdout.write(event.content);
  if (event.type === 'stream_start') process.stdout.write('\n');
  if (event.type === 'stream_end')   process.stdout.write('\n');
  if (event.type === 'tool_start')   process.stdout.write(dim(`\n  [${event.name}] ${JSON.stringify(event.args||{}).slice(0,80)}…\n`));
  if (event.type === 'tool_result')  process.stdout.write(dim(`  → ${String(event.result||'').split('\n')[0].slice(0,100)}\n`));
  if (event.type === 'system')       process.stdout.write(dim(`\n  ${event.text}\n`));
  if (event.type === 'done')         process.stdout.write('\n');
}

// ---- CLI runner ----
async function runCLI() {
  console.clear();
  console.log(bold(`\n  ${NAME}`) + dim(`  ·  ${state.activeModel}  ·  ${process.platform}/${process.arch}`));
  console.log(dim(`  /exit  /task <goal>  /model [name]  /mem  /forget  /help\n`));

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
  process.on('SIGINT', close);

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
    if (input === '/help') {
      console.log(dim('\n  /task <goal>   autonomous multi-step task\n  /model [name]  show or switch active model\n  /mem           show long-term memory\n  /forget        clear current context\n  /exit          save session + quit\n'));
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

    messages.push({ role: 'user', content: input });
    try { await turn(messages, cliEmit); } catch (e) { console.log(`\n  error: ${e.message}\n`); }
  }
}

// ---- Entry point ----
if (UI_MODE) {
  const messages = freshMessages();
  process.on('SIGINT', async () => { await saveAndSummarize(messages); process.exit(0); });
  await serveUI(messages);
} else {
  await runCLI();
}
