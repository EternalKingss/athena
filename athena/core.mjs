// core.mjs -- turn loop, task runner, context compression
import { chat, chatStream } from './api.mjs';
import { TOOLS, DESTRUCTIVE, classifyRisk, runTool } from './tools.mjs';
import { loadFingerprint } from './machines.mjs';
import { saveSkill, updateSkill, scanSkills, recordSkillResult } from './skills.mjs';
import { systemPrompt, offlineSystemPrompt } from './personality.mjs';
import { AUTO, state, API_KEY, ANTHROPIC_KEY, isOfflineMode } from './config.mjs';
import { estimateMessages, getModelBudget } from './tokens.mjs';
import { compressOutput } from './compress.mjs';

// ---- Session state ----
// These are scoped to the MAIN agent only.
// Background agents get their own isolated todos (passed via turn() closure).
let SESSION_TODOS = [];
let _requestUserInput = null; // set by CLI or UI runner
let _interrupted = false;
let _turnActive   = false;

export function setRequestUserInput(fn) { _requestUserInput = fn; }
export function setSessionTodos(t) { SESSION_TODOS = t; }
export function setInterrupt() { if (_turnActive) _interrupted = true; }
export function isActive() { return _turnActive; }

// Background agents get a no-op clarify so they never block waiting for user input
const _noopInput = async (question) => `(background agent -- cannot ask user: ${question})`;


// ---- Context compression ----
const COMPRESS_KEEP_START = 2;
const COMPRESS_KEEP_END   = 15;

async function maybeCompress(messages, emit, currentTodos = []) {
  // Token-aware: compress when estimated tokens reach 75% of model budget,
  // OR as a safety net when message count hits 80 (prevents unbounded growth).
  const tokenBudget = getModelBudget(state.activeModel);
  const estimated   = estimateMessages(messages);
  if (estimated < tokenBudget * 0.75 && messages.length < 80) return;
  const start  = messages.slice(0, COMPRESS_KEEP_START);
  let end      = messages.slice(-COMPRESS_KEEP_END);
  let middle   = messages.slice(COMPRESS_KEEP_START, -COMPRESS_KEEP_END);
  if (middle.length < 6) return;

  // ---- Boundary safety ----
  // The end slice must start on a clean message boundary -- a real user message,
  // not a tool result. If it starts mid tool-call sequence (role:'tool' or an
  // assistant with tool_calls whose results are in end), the API returns HTTP 400.
  //
  // Fix: walk forward in end until we hit the first role:'user' message.
  // Everything before that belongs with its tool_calls pair -- move it to middle.
  const safeStart = end.findIndex(m => m.role === 'user');
  if (safeStart > 0) {
    middle = [...middle, ...end.slice(0, safeStart)];
    end    = end.slice(safeStart);
  }

  // Also ensure start doesn't end on an assistant message that has tool_calls
  // (its tool results would land in middle and get compressed away).
  while (start.length > 1 && start[start.length - 1].tool_calls?.length) {
    middle.unshift(start.pop());
  }

  if (middle.length < 4) return; // not worth compressing after boundary adjustments

  emit({ type: 'system', text: `Compressing ${middle.length} messages (~${estimated} tokens estimated, budget ${tokenBudget})…` });
  // Use cheapest available model for compression -- no reason to burn expensive tokens on housekeeping
  const savedModel = state.activeModel;
  if (API_KEY) state.activeModel = 'gpt-4o-mini';
  else if (ANTHROPIC_KEY) state.activeModel = 'claude-haiku-4-5-20251001';
  // else: offline mode -- local model stays active for compression
  try {
    const sum = await chat([
      { role: 'system', content: 'Summarize this conversation in 10-15 bullet points. Be specific: include filenames, commands, values, decisions, problems solved, current state. No preamble.' },
      { role: 'user', content: middle.filter(m => m.role === 'user' || m.role === 'assistant').map(m => `${m.role}: ${m.content || '[tool]'}`).join('\n') },
    ]);
    const summary = { role: 'assistant', content: `[Context compressed -- ${middle.length} messages → summary]\n${sum.content || ''}` };
    const todoReinject = currentTodos.length
      ? [{ role: 'user', content: `[Task list after compression]\n${JSON.stringify(currentTodos)}` }]
      : [];
    messages.length = 0;
    messages.push(...start, summary, ...todoReinject, ...end);
    emit({ type: 'system', text: `Compressed (${middle.length} → 1). Continuing…` });
  } catch (e) { import('./telemetry.mjs').then(({ logError }) => logError('compression', e)).catch(() => {}); } finally {
    state.activeModel = savedModel;
  }
}

// ---- Core turn loop ----
// opts.isolated = true → use private todos + no-op clarify (for background agents)
export async function turn(messages, emit, opts = {}) {
  if (!opts.isolated) { _turnActive = true; _interrupted = false; }
  emit({ type: 'status', text: 'thinking' });

  // Isolated agents get their own todo list and a no-op input handler
  // so they never block or interfere with the main agent's state
  let agentTodos = opts.isolated ? [] : SESSION_TODOS;
  const setAgentTodos = opts.isolated ? (t => { agentTodos = t; }) : setSessionTodos;
  const inputHandler  = opts.isolated ? _noopInput : _requestUserInput;

  await maybeCompress(messages, emit, agentTodos);

  const MAX_TOOL_ITERATIONS = 50;
  let toolIterations = 0;
  const onTurnStart = opts.onTurnStart || null;
  let _lastLoadedSkill = null;
  let _hadToolError    = false;

  // ---- Loop / stall detection (Agent Introspection) ----
  // Tracks the last N tool calls. If the same tool+args combo repeats 3x in a row
  // Athena injects a self-diagnosis prompt instead of blindly retrying.
  const recentCalls = [];   // { name, argsHash }
  const LOOP_WINDOW  = 3;
  function argsHash(args) { return JSON.stringify(args).slice(0, 120); }
  function detectLoop(name, args) {
    const sig = `${name}:${argsHash(args)}`;
    recentCalls.push(sig);
    if (recentCalls.length > LOOP_WINDOW) recentCalls.shift();
    return recentCalls.length === LOOP_WINDOW && recentCalls.every(s => s === sig);
  }

  while (true) {
    if (onTurnStart) onTurnStart();
    if (toolIterations >= MAX_TOOL_ITERATIONS) {
      emit({ type: 'error', message: `Stopped after ${MAX_TOOL_ITERATIONS} tool iterations to prevent runaway loop.` });
      emit({ type: 'done' }); return;
    }
    let textContent = '';
    const toolCallMap = {};
    let hasTools = false;

    for await (const chunk of chatStream(messages, TOOLS)) {
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        if (!textContent) emit({ type: 'stream_start' });
        textContent += delta.content;
        emit({ type: 'token', content: delta.content });
      }

      if (delta.tool_calls) {
        hasTools = true;
        for (const tc of delta.tool_calls) {
          const slot = (toolCallMap[tc.index] ??= { id: '', name: '', args: '' });
          if (tc.id)                  slot.id   += tc.id;
          if (tc.function?.name)      slot.name += tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
        }
      }
    }

    if (textContent) emit({ type: 'stream_end' });

    const msg = { role: 'assistant', content: textContent || null };
    if (hasTools) {
      msg.tool_calls = Object.values(toolCallMap).map(tc => ({
        id: tc.id, type: 'function',
        function: { name: tc.name, arguments: tc.args },
      }));
    }
    messages.push(msg);

    if (!msg.tool_calls?.length) {
      if (!opts.isolated) {
        _turnActive = false;
        // Phase 16b: drain any watcher alerts that queued while we were mid-turn
        try {
          const { drainPendingAlerts } = await import('./watcher.mjs').catch(() => ({}));
          if (drainPendingAlerts) drainPendingAlerts(emit);
        } catch {}
      }
      if (_lastLoadedSkill) { recordSkillResult(_lastLoadedSkill, !_hadToolError); _lastLoadedSkill = null; }
      emit({ type: 'done' }); return;
    }
    toolIterations++;

    // ---- Execute tool calls ----
    const calls = msg.tool_calls.map(call => {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
      return { call, args };
    });

    // Tiered approval (Phase 8)
    const _machineProfile = loadFingerprint();
    // Isolated (background) agents auto-run Tier 0/1 but must NOT silently
    // auto-approve Tier 2 destructive actions -- they have no human to approve.
    // Only the global AUTO_APPROVE flag may blanket-approve everything.
    const autoApproveAll = AUTO;
    const classified = calls.map(({ call, args }) => ({
      call, args,
      risk: classifyRisk(call.function.name, args, _machineProfile),
    }));

    let batchApproved = autoApproveAll;
    // Background agents cannot prompt a human -- skip the gate so Tier 2 calls
    // stay unapproved (runTool denies them) instead of blocking forever.
    if (!batchApproved && !opts.isolated) {
      const tier2 = classified.filter(({ risk }) => risk.tier === 2);
      if (tier2.length) {
        if (process.env.ATHENA_UI !== '1') {
          emit({ type: 'approval_request', calls: tier2.map(({ call, args, risk }) => ({
            name: call.function.name,
            preview: (args.command || args.path || JSON.stringify(args).slice(0, 80)),
            reason: risk.reason,
          }))});
          batchApproved = await cliApprove(tier2, emit);
        } else {
          // UI mode: show gate for the first pending Tier 2 call, batch-approve on yes
          emit({ type: 'approval_required', tool: tier2[0].call.function.name, args: tier2[0].args, tier: 2, reason: tier2[0].risk.reason });
          const resp = await inputHandler('Approve? (yes/no)', ['yes', 'no']);
          batchApproved = (resp || '').toLowerCase().startsWith('y');
        }
      }
    }

    const toolResults = [];
    let loopDetected = false;
    for (const { call, args, risk } of classified) {
      emit({ type: 'tool_start', name: call.function.name, args });
      if (risk.tier === 1 && !opts.isolated) {
        emit({ type: 'action_taken', name: call.function.name, reason: risk.reason, args });
      }
      const approved = autoApproveAll || batchApproved || risk.tier < 2;
      let result;
      try {
        result = await runTool(
          call.function.name, args,
          approved,
          agentTodos, setAgentTodos, inputHandler
        );
      } catch (e) {
        result = 'Error: ' + e.message;
      }
      emit({ type: 'tool_result', name: call.function.name, result });
      // Sync the UI todo strip whenever the todo tool updates the task list
      if (call.function.name === 'todo' && !opts.isolated) {
        emit({ type: 'todo_update', todos: SESSION_TODOS });
      }
      const compressed = compressOutput(String(result), call.function.name);
      toolResults.push({ role: 'tool', tool_call_id: call.id, content: compressed });

      // Skill success/failure tracking
      if (call.function.name === 'load_skill' && args.name) {
        const r = String(result);
        if (!r.startsWith('Skill "') && !r.startsWith('Error:')) _lastLoadedSkill = args.name;
      }
      if (String(result).startsWith('Error: ') && _lastLoadedSkill) {
        recordSkillResult(_lastLoadedSkill, false);
        _lastLoadedSkill = null;
        _hadToolError = true;
      }

      // Loop detection -- same tool+args 3x in a row = inject introspection prompt
      if (detectLoop(call.function.name, args)) loopDetected = true;
    }
    messages.push(...toolResults);

    // ---- Agent introspection injection ----
    // If a loop is detected, force a self-diagnosis before the next LLM call.
    // This breaks the retry cycle and makes Athena explain + change approach.
    if (loopDetected) {
      recentCalls.length = 0; // reset so one injection is enough
      emit({ type: 'system', text: 'Loop detected -- running self-diagnosis…' });
      messages.push({
        role: 'user',
        content: [
          '[introspection] You have called the same tool with the same arguments 3 times in a row without progress.',
          'STOP retrying. Run the four-phase self-diagnosis:',
          '1. CAPTURE -- What exactly failed? What were you trying to achieve?',
          '2. DIAGNOSE -- Which pattern applies: tool loop, environment mismatch, bad assumption, permission issue, wrong file path, context drift?',
          '3. RECOVER -- What is the SMALLEST different action you can take? Change one thing.',
          '4. REPORT -- State what you found and what you are doing differently. Then proceed with the new approach.',
          'Do NOT repeat the same call again.',
        ].join('\n'),
      });
    }

    // Check for interrupt signal (main agent only)
    if (_interrupted && !opts.isolated) {
      _interrupted = false;
      _turnActive  = false;
      emit({ type: 'system', text: 'Interrupted -- summarising...' });
      messages.push({ role: 'user', content: 'You were interrupted mid-task. Briefly summarise: what did you accomplish so far, and what was still left to do?' });
      let summary = '';
      try {
        for await (const chunk of chatStream(messages, [])) {
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            if (!summary) emit({ type: 'stream_start' });
            summary += delta.content;
            emit({ type: 'token', content: delta.content });
          }
        }
      } catch { /* non-fatal -- fall through to push placeholder */ }
      if (summary) {
        emit({ type: 'stream_end' });
      } else {
        // Stream failed or returned nothing -- show the fallback visibly
        summary = 'Interrupted. I may have been mid-task; just let me know what to continue.';
        emit({ type: 'stream_start' });
        emit({ type: 'token', content: summary });
        emit({ type: 'stream_end' });
      }
      messages.push({ role: 'assistant', content: summary });
      emit({ type: 'done' });
      return;
    }
  }
  if (!opts.isolated) _turnActive = false;
}

// ---- CLI approval helper ----
async function cliApprove(destructive, emit) {
  if (!_requestUserInput) return false;
  const preview = destructive.map(({ call, args }) =>
    `  ${call.function.name}: ${args.command || args.path || JSON.stringify(args).slice(0, 60)}`
  ).join('\n');
  const answer = await _requestUserInput(
    `Approve ${destructive.length} destructive action(s)?\n${preview}`,
    ['yes', 'no', 'yes to all']
  );
  return answer === 'yes' || answer === 'yes to all';
}

// ---- Task runner (/task <goal>) ----
// Dynamic Workflow Mode: every task defines its own success criteria + handoff artifact
// before execution starts. This prevents drift and makes "done" unambiguous.
export async function runTask(goal, messages, emit) {
  emit({ type: 'system', text: `Task: ${goal}` });
  const taskMsg = {
    role: 'user',
    content: [
      `You are now running in autonomous task mode.`,
      ``,
      `Goal: ${goal}`,
      ``,
      `BEFORE you start executing, define your harness:`,
      `1. OBJECTIVE -- restate the goal in one sentence (what you own, what you don't)`,
      `2. DONE CRITERIA -- list 1-3 specific, verifiable conditions that mean this task is complete`,
      `3. INPUTS/OUTPUTS -- what you need, what you will produce`,
      ``,
      `Then use the todo tool to build your step list, execute step by step, and check each step against your done criteria.`,
      ``,
      `When finished, produce a HANDOFF: what was done, current state, and any follow-up needed.`,
      `If a step fails 2+ times, STOP and apply introspection -- change approach before retrying.`,
      ``,
      `Promote any repeatable pattern from this task to a skill with save_skill.`,
    ].join('\n'),
  };
  messages.push(taskMsg);

  const toolTrace = [];
  const tracingEmit = ev => {
    if (ev.type === 'tool_start') toolTrace.push({ name: ev.name, args: ev.args });
    emit(ev);
  };
  await turn(messages, tracingEmit);

  // Phase 9: auto-crystallization
  // Strip load_skill calls -- crystallizing from another skill's trace causes drift loops
  const CRYSTALLIZE_MIN_TOOLS = 4;
  const primitiveTrace = toolTrace.filter(t => t.name !== 'load_skill');
  if (primitiveTrace.length >= CRYSTALLIZE_MIN_TOOLS) {
    crystallize(goal, primitiveTrace, emit).catch(e => {
      // Non-fatal -- crystallization failures are best-effort
      import('./telemetry.mjs').then(({ logError }) => logError('crystallize', e)).catch(() => {});
    });
  }
}

// Phase 9: crystallize helper
export async function crystallize(goal, toolTrace, emit) {
  const savedModel = state.activeModel;
  if (API_KEY) state.activeModel = 'gpt-4o-mini';
  else if (ANTHROPIC_KEY) state.activeModel = 'claude-haiku-4-5-20251001';
  // else: offline mode -- local model stays active for crystallization
  try {
    const traceText = toolTrace.map(t =>
      t.name + '(' + Object.entries(t.args || {}).map(([k, v]) => k + '=' + JSON.stringify(v).slice(0, 60)).join(', ') + ')'
    ).join('\n');
    const res = await chat([
      { role: 'system', content: 'You are a skill extractor for an AI agent. Analyse the tool trace and decide if it encodes a general, repeatable pattern.' },
      { role: 'user', content: 'Task goal: ' + goal + '\n\nTool call trace (' + toolTrace.length + ' calls):\n' + traceText + '\n\nIs this a repeatable pattern worth saving as a reusable skill?\nReply in this EXACT JSON format (no markdown): {"repeatable": true/false, "skillName": "kebab-case-name", "description": "one-line description", "content": "markdown skill instructions"}\nIf not repeatable, reply: {"repeatable": false}' },
    ]);
    let parsed;
    try { parsed = JSON.parse((res.content || '').trim()); } catch { return; }
    if (!parsed || !parsed.repeatable || !parsed.skillName) return;
    const existing = scanSkills().find(s => s.dir === parsed.skillName);
    if (existing) {
      await updateSkill(parsed.skillName, parsed.description, parsed.content, 'unverified');
      emit({ type: 'system', text: 'Crystallized: updated skill "' + parsed.skillName + '" (unverified -- will verify on next successful use)' });
    } else {
      await saveSkill(parsed.skillName, parsed.description, parsed.content, 'unverified');
      emit({ type: 'system', text: 'Crystallized: new skill "' + parsed.skillName + '" saved (unverified -- will verify on next successful use)' });
    }
    broadcastSkill(parsed.skillName, parsed.description, parsed.content, emit);
  } catch { } finally {
    state.activeModel = savedModel;
  }
}

let _broadcastSkill = () => {};
export function setBroadcastSkill(fn) { _broadcastSkill = fn; }
function broadcastSkill(...args) { _broadcastSkill(...args); }

// ---- Fresh message array factory -- mode-aware ----
export function freshMessages() {
  return [{ role: 'system', content: isOfflineMode() ? offlineSystemPrompt() : systemPrompt() }];
}

// ---- L2/L3/L4 routing: turnWithFallback ----
// L2 (Control Engine) handles known diagnostic intents deterministically.
// L3 (local LLM) handles ambiguous intent when no cloud key.
// L4 (cloud LLM) handles everything when available.
// L2 state truth is immutable -- L3/L4 may only annotate, not contradict.
export async function turnWithFallback(messages, emit, opts = {}) {
  const hasCloud = !isOfflineMode();
  const hasLocal = !hasCloud && await import('./local_llm.mjs').then(m => m.isLocalLLMRunning()).catch(() => false);
  const hasLLM   = hasCloud || hasLocal;

  // L2: check if input maps to a known workflow
  const { detectIntents, runPlan } = await import('./control_engine.mjs');
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const input    = typeof lastUser?.content === 'string' ? lastUser.content : '';
  const intents  = detectIntents(input);

  if (intents) {
    // L2 handles this -- run deterministic plan regardless of LLM availability
    emit({ type: 'status', text: 'running' });
    emit({ type: 'stream_start' });
    const report = await runPlan(intents, emit);
    // If LLM available, append AI interpretation (annotate only, never override)
    if (hasLLM) {
      emit({ type: 'token', content: report });
      messages.push({ role: 'assistant', content: report });
      // Feed to LLM as context for interpretation
      messages.push({ role: 'user', content: '[L2 diagnostic report above -- please interpret and summarize key findings. Do NOT contradict the DATA or STATUS fields.]' });
      emit({ type: 'stream_end' });
      return turn(messages, emit, opts);
    }
    emit({ type: 'token', content: report });
    emit({ type: 'stream_end' });
    messages.push({ role: 'assistant', content: report });
    emit({ type: 'done' });
    return;
  }

  if (hasLLM) {
    // Unknown intent but LLM available -- let it handle
    return turn(messages, emit, opts);
  }

  // No LLM, no known intent -- show capability list
  const { listWorkflows } = await import('./control_engine.mjs');
  const wfList = listWorkflows().map(w => '  ' + w.name).join('\n');
  emit({ type: 'status', text: 'done' });
  emit({ type: 'stream_start' });
  const msg = [
    '[Control Engine -- no AI model available]',
    '',
    'I cannot interpret this request without AI reasoning.',
    'Available direct diagnostics (just describe what you need):',
    wfList,
    '',
    'To enable AI reasoning: run runtime/get-offline.sh  (~2.2 GB download)',
    'Or add OPENAI_API_KEY / ANTHROPIC_API_KEY to config/.env',
  ].join('\n');
  emit({ type: 'token', content: msg });
  emit({ type: 'stream_end' });
  messages.push({ role: 'assistant', content: msg });
  emit({ type: 'done' });
}
