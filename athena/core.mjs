// core.mjs -- turn loop, task runner, context compression
import { chat, chatStream } from './api.mjs';
import { classifyRisk, previewCall, irreversibleReason } from './tools.mjs';
import { dispatch } from './kernel/router.mjs';
import { toolsForModel } from './kernel/toolSurface.mjs';
import { loadFingerprint } from './machines.mjs';
import { tryLocalFirst } from './task_router.mjs';
import { saveSkill, updateSkill, scanSkills, recordSkillResult } from './skills.mjs';
import { systemPrompt, offlineSystemPrompt } from './personality.mjs';
import { AUTO, AUTO_ALL, state, ANTHROPIC_KEY, isOfflineMode, isLocalModelActive } from './config.mjs';
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
// Exported so watcher.mjs can checkpoint real task state. It imported SESSION_TODOS
// directly, which core.mjs never exported -- so every checkpoint silently wrote [].
export function getSessionTodos() { return SESSION_TODOS; }
export function setInterrupt() { if (_turnActive) _interrupted = true; }
export function isActive() { return _turnActive; }

// Background agents get a no-op clarify so they never block waiting for user input
const _noopInput = async (question) => `(background agent -- cannot ask user: ${question})`;


// ---- Context compression ----
const COMPRESS_KEEP_START = 2;
const COMPRESS_KEEP_END   = 15;

async function maybeCompress(messages, emit, currentTodos = [], opts = {}) {
  // Token-aware: compress when estimated tokens reach 75% of model budget,
  // OR as a safety net when message count hits 80 (prevents unbounded growth).
  // opts.force bypasses both checks -- used when a local model has already
  // rejected a request as over its context window, so compression has to
  // happen right now regardless of what the estimate says.
  const tokenBudget = getModelBudget(state.activeModel);
  const estimated   = estimateMessages(messages);
  if (!opts.force && estimated < tokenBudget * 0.75 && messages.length < 80) return;
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
  // Cheapest available model for housekeeping, passed per call. Assigning
  // state.activeModel here and restoring it in finally raced with concurrent background
  // agents -- their requests could land on haiku, or their model switch get clobbered.
  const cheapModel = ANTHROPIC_KEY ? 'claude-haiku-4-5-20251001' : undefined;
  try {
    const sum = await chat([
      { role: 'system', content: 'Summarize this conversation in 10-15 bullet points. Be specific: include filenames, commands, values, decisions, problems solved, current state. No preamble.' },
      { role: 'user', content: middle.filter(m => m.role === 'user' || m.role === 'assistant').map(m => `${m.role}: ${m.content || '[tool]'}`).join('\n') },
    ], { model: cheapModel });
    const summary = { role: 'assistant', content: `[Context compressed -- ${middle.length} messages → summary]\n${sum.content || ''}` };
    const todoReinject = currentTodos.length
      ? [{ role: 'user', content: `[Task list after compression]\n${JSON.stringify(currentTodos)}` }]
      : [];
    messages.length = 0;
    messages.push(...start, summary, ...todoReinject, ...end);
    emit({ type: 'system', text: `Compressed (${middle.length} → 1). Continuing…` });
  } catch (e) { import('./telemetry.mjs').then(({ logError }) => logError('compression', e)).catch(() => {}); }
}

// ---- Core turn loop ----
// opts.isolated = true → use private todos + no-op clarify (for background agents)
export async function turn(messages, emit, opts = {}) {
  if (!opts.isolated) {
    _turnActive = true; _interrupted = false;
    // A local-model start that failed last turn gets one more chance this turn.
    import('./api.mjs').then(m => m.resetLocalStartAttempt?.()).catch(() => {});
  }
  emit({ type: 'status', text: 'thinking' });

  // ---- Pre-Claude cost gate ----
  // Before this turn touches any cloud model at all, see if the message is
  // obviously basic/mechanical enough to hand entirely to a local model --
  // no Claude call for this turn, not even to decide. Skipped for isolated
  // (background agent) turns and for anything the caller explicitly opts
  // out of. Fails open: if the local attempt doesn't actually finish the
  // job, tryLocalFirst() reports { handled: false } and this falls straight
  // through into the normal loop below exactly as if it had never run.
  if (!opts.isolated && !opts.skipLocalRouting) {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const userText = typeof lastUser?.content === 'string' ? lastUser.content : '';
    if (userText) {
      const routed = await tryLocalFirst(userText, emit).catch(() => ({ handled: false }));
      if (routed.handled) {
        messages.push({ role: 'assistant', content: routed.finalText || '(done)' });
        _turnActive = false;
        emit({ type: 'done', text: routed.finalText || undefined });
        return;
      }
    }
  }

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

  let _forcedCompressAttempted = false;
  while (true) {
    if (onTurnStart) onTurnStart();
    if (toolIterations >= MAX_TOOL_ITERATIONS) {
      import('./telemetry.mjs').then(({ logError }) => logError('runaway_loop', new Error(`Stopped after ${MAX_TOOL_ITERATIONS} tool iterations`), { model: state.activeModel })).catch(() => {});
      emit({ type: 'error', message: `Stopped after ${MAX_TOOL_ITERATIONS} tool iterations to prevent runaway loop.` });
      emit({ type: 'done' }); return;
    }
    let textContent = '';
    const toolCallMap = {};
    let hasTools = false;

    try {
    for await (const chunk of chatStream(messages, toolsForModel(state.activeModel))) {
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
    } catch (netErr) {
      // A local model rejecting the request as too big for its own context window is
      // recoverable -- force a compression pass and retry once. Bounded to one retry
      // per turn so this can't become a second infinite loop in place of the first.
      if (netErr.localContextExceeded) {
        import('./telemetry.mjs').then(({ logError }) => logError('local_context_exceeded', netErr, { model: state.activeModel, messages: messages.length, retried: _forcedCompressAttempted })).catch(() => {});
        if (!_forcedCompressAttempted) {
          _forcedCompressAttempted = true;
          emit({ type: 'system', text: "Local model's context window filled up -- compressing the conversation and retrying." });
          await maybeCompress(messages, emit, agentTodos, { force: true });
          continue;
        }
        emit({ type: 'error', message: "The local model's context window is too small for this conversation, even after compressing. Try /forget to clear it, or /model to switch to a cloud model." });
        emit({ type: 'done' });
        if (!opts.isolated) { _turnActive = false; }
        return;
      }
      // Rate limit / provider failure is NOT the same as being offline.
      // "exhausted" means every model was tried and refused (usually 429).
      if (netErr.message && netErr.message.includes('exhausted')) {
        let hint = 'Wait a minute and try again.';
        try {
          const { detectLocalModels } = await import('./local_llm.mjs');
          const local = detectLocalModels();
          hint = local.length
            ? 'A local model is on disk (' + local.map(m => m.id).join(', ') + ') but could not be started -- check runtime/llama-server and runtime/models/.'
            : 'No local model is installed, so there is nothing to fall back to. Run runtime/get-offline.sh to add one.';
        } catch {}
        import('./telemetry.mjs').then(({ logError }) => logError('models_exhausted', netErr, { model: state.activeModel })).catch(() => {});
        emit({ type: 'error', message: 'Every cloud model refused (rate limit, quota, or credits). You are NOT offline. ' + hint });
        emit({ type: 'done' });
        if (!opts.isolated) { _turnActive = false; }
        return;
      }
      const isNetErr = netErr instanceof TypeError ||
        (netErr.message && (netErr.message.includes('fetch') || netErr.message.includes('ENOTFOUND') || netErr.message.includes('ECONNREFUSED')));
      if (!isNetErr) {
        import('./telemetry.mjs').then(({ logError }) => logError('turn_llm_call', netErr, { model: state.activeModel })).catch(() => {});
        throw netErr;
      }
      emit({ type: 'system', text: 'Network unavailable -- offline mode (L2 engine active)' });
      const { detectIntents, runPlan } = await import('./control_engine.mjs');
      const lastUser = [...messages].reverse().find(m => m.role === 'user');
      const userInput = typeof lastUser?.content === 'string' ? lastUser.content : '';
      const intents = detectIntents(userInput);
      emit({ type: 'stream_start' });
      if (intents) {
        const report = await runPlan(intents, emit);
        emit({ type: 'token', content: report });
        messages.push({ role: 'assistant', content: report });
      } else {
        // Offline and the phrasing did not map to a workflow. A menu is useless to
        // someone whose machine is broken -- run the broad health sweep and say what is
        // actually wrong, then offer the narrower checks.
        emit({ type: 'token', content: "I'm offline -- no internet. Running a full local check instead of guessing.\n\n" });
        let report;
        try { report = await runPlan(['system_health', 'network_check'], emit); }
        catch (e) { report = '(local diagnostics failed: ' + e.message + ')'; }
        const tail = "\n\nIf that missed it, name the area: disk, network, adapter/driver, boot, processes, logs, services.";
        emit({ type: 'token', content: report + tail });
        messages.push({ role: 'assistant', content: report + tail });
      }
      emit({ type: 'stream_end' });
      emit({ type: 'done' });
      if (!opts.isolated) { _turnActive = false; }
      return;
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
    // Background agents used to auto-approve EVERYTHING: spawn_agent was tier 0, so one
    // unapproved call produced an agent that ran tier-2 shell commands with no gate at
    // all. They cannot prompt (their input handler is a no-op), so the correct default
    // for them is deny, not allow.
    const autoApproveAll = AUTO;
    const classified = calls.map(({ call, args }) => ({
      call, args,
      risk: classifyRisk(call.function.name, args, _machineProfile),
    }));

    // Under AUTO, only the irreversible still stops. AUTO_APPROVE_ALL removes even that.
    const irreversible = AUTO_ALL ? [] : classified
      .map(c => ({ ...c, why: irreversibleReason(c.call.function.name, c.args) }))
      .filter(c => c.why);

    let batchApproved = autoApproveAll && irreversible.length === 0;
    if (!batchApproved) {
      const tier2 = autoApproveAll
        ? irreversible                                   // AUTO: ask only about the unrecoverable
        : classified.filter(({ risk }) => risk.tier === 2);
      if (tier2.length) {
        if (process.env.ATHENA_UI !== '1') {
          emit({ type: 'approval_request', calls: tier2.map(({ call, args, risk }) => ({
            name: call.function.name,
            preview: previewCall(call.function.name, args),
            reason: risk.reason,
          }))});
          batchApproved = await cliApprove(tier2, emit);
        } else {
          // Render EVERY pending tier-2 call, not just the first. One boolean approves
          // the whole batch, so showing only tier2[0] meant a benign-looking call could
          // carry a destructive one through on the same yes.
          emit({
            type: 'approval_required',
            tool:  tier2.map(t => t.call.function.name).join(', '),
            args:  tier2.map(t => t.args),
            tier:  2,
            reason: tier2.map(t => t.risk.reason).join(' | '),
            calls: tier2.map(t => ({
              name:    t.call.function.name,
              preview: previewCall(t.call.function.name, t.args),
              reason:  t.risk.reason,
            })),
          });
          const _list = tier2.map(t => '  - ' + t.call.function.name + ': ' + previewCall(t.call.function.name, t.args)).join('\n');
          const resp = await inputHandler('Approve ' + tier2.length + ' action(s)?\n' + _list, ['yes', 'no']);
          batchApproved = (resp || '').toLowerCase().startsWith('y');
        }
      }
    }

    const toolResults = [];
    let loopDetected = false;
    let _loopTool = null, _loopWasError = false, _loopReason = null, _loopArgs = null;
    for (const { call, args, risk } of classified) {
      // ui.mjs reads ev.tier here to style the tool block and drive the "tier N autonomy"
      // badge, but core.mjs never sent one -- so every call rendered as tier 0 regardless
      // of what it did. The old 'action_taken' event was emitted and consumed by nothing.
      emit({ type: 'tool_start', name: call.function.name, args, tier: risk.tier, reason: risk.reason });
      // A tier-2 call under AUTO_APPROVE runs with no prompt, so this line is the only
      // thing telling the user a system change is happening. Tier 2 was the quietest of
      // the three, which is backwards.
      if (!opts.isolated && risk.tier === 2 && autoApproveAll) {
        emit({ type: 'system', text: 'Running without asking (' + call.function.name + '): ' + risk.reason });
      }
      // The prohibited-patterns feature wrote dead ends and fed them to the system prompt
      // as prose, but nothing ever checked a call against them, so the same failing call
      // could be made again on the next turn. Warn on the result rather than refusing:
      // the entry proves this failed three times before, not that it can never work.
      let _deadEnd = null;
      try {
        const { checkProhibited } = await import('./memory.mjs');
        _deadEnd = checkProhibited(call.function.name, args);
      } catch {}
      if (_deadEnd && !opts.isolated) {
        emit({ type: 'system', text: 'Note: this exact call was recorded as a dead end before.' });
      }

      const blockedReason = AUTO_ALL ? null : irreversibleReason(call.function.name, args);
      const approved = batchApproved ||
        (autoApproveAll && !blockedReason) ||
        (!autoApproveAll && risk.tier < 2 && !(opts.isolated && risk.tier > 0));
      let result;
      try {
        result = await dispatch(
          call.function.name, args,
          { preApproved: approved, sessionTodos: agentTodos, setSessionTodos: setAgentTodos, requestUserInput: inputHandler }
        );
      } catch (e) {
        result = 'Error: ' + e.message;
      }
      emit({ type: 'tool_result', name: call.function.name, result });
      // Sync the UI todo strip whenever the todo tool updates the task list
      if (call.function.name === 'todo' && !opts.isolated) {
        emit({ type: 'todo_update', todos: SESSION_TODOS });
      }
      const withNote = _deadEnd
        ? String(result) + '\n\n[memory] You recorded this exact call as a dead end previously: ' +
          _deadEnd.replace(/^\[env:[^\]]*\]\s*/, '') + '\nIf it failed the same way again, change approach rather than retrying.'
        : String(result);
      const compressed = compressOutput(withNote, call.function.name);
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
      if (detectLoop(call.function.name, args)) {
        loopDetected  = true;
        _loopTool     = call.function.name;
        _loopArgs     = args;
        _loopWasError = String(result).startsWith('Error:') || /not approved|denied|not found/i.test(String(result).slice(0, 120));
        _loopReason   = String(result).slice(0, 120);
      }
    }
    messages.push(...toolResults);

    // ---- Agent introspection injection ----
    // If a loop is detected, force a self-diagnosis before the next LLM call.
    // This breaks the retry cycle and makes Athena explain + change approach.
    if (loopDetected) {
      recentCalls.length = 0; // reset so one injection is enough
      // Record the dead end. loadProhibited() feeds these back into the system prompt, but
      // nothing ever wrote one, so the whole prohibited-patterns feature could never hold
      // data. A tool that failed identically three times in a row is exactly the signal
      // it was built for.
      if (_loopTool && _loopWasError) {
        import('./memory.mjs')
          .then(({ logProhibitedPattern }) => logProhibitedPattern(_loopTool, _loopReason || 'repeated identical call with no progress', undefined, _loopArgs))
          .catch(() => {});
      }
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
    `  ${call.function.name}: ${previewCall(call.function.name, args)}`
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
  const cheapModel = ANTHROPIC_KEY ? 'claude-haiku-4-5-20251001' : undefined;
  try {
    const traceText = toolTrace.map(t =>
      t.name + '(' + Object.entries(t.args || {}).map(([k, v]) => k + '=' + JSON.stringify(v).slice(0, 60)).join(', ') + ')'
    ).join('\n');
    const res = await chat([
      { role: 'system', content: 'You are a skill extractor for an AI agent. Analyse the tool trace and decide if it encodes a general, repeatable pattern.' },
      { role: 'user', content: 'Task goal: ' + goal + '\n\nTool call trace (' + toolTrace.length + ' calls):\n' + traceText + '\n\nIs this a repeatable pattern worth saving as a reusable skill?\nReply in this EXACT JSON format (no markdown): {"repeatable": true/false, "skillName": "kebab-case-name", "description": "one-line description", "content": "markdown skill instructions"}\nIf not repeatable, reply: {"repeatable": false}' },
    ], { model: cheapModel });
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
  } catch { }
}

let _broadcastSkill = () => {};
export function setBroadcastSkill(fn) { _broadcastSkill = fn; }
function broadcastSkill(...args) { _broadcastSkill(...args); }

// ---- Fresh message array factory -- mode-aware ----
export function freshMessages() {
  return [{ role: 'system', content: (isOfflineMode() || isLocalModelActive()) ? offlineSystemPrompt() : systemPrompt() }];
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
      if (hasCloud) {
        messages.push({ role: 'user', content: '[L2 diagnostic report above -- interpret and summarize the key findings. The DATA blocks are measured output: do not invent values that contradict them. STATUS is a heuristic over that data, so if the DATA shows something the STATUS missed, say so.]' });
      } else {
        // L3 is a small local model. Give it the computed findings and the fix list, not
        // the raw data -- a narrow job it gets right instead of a broad one it fabricates.
        const { lastPlanSummary } = await import('./control_engine.mjs');
        const plan = lastPlanSummary();
        let fixList = '';
        try {
          const { allFixes } = await import('./machine_fixes.mjs');
          fixList = (await allFixes()).map(f => f.id + ' -- ' + f.title).join('\n');
        } catch { fixList = '(fix library unavailable)'; }
        messages.push({ role: 'user', content: [
          '[L2 already inspected this machine. Below is what it measured -- treat it as fact.]',
          '',
          'L2 STATUS: ' + plan.status,
          'FINDINGS:',
          plan.findings.length ? plan.findings.map(f => '- ' + f).join('\n') : '(none)',
          '',
          'Fix ids available:',
          fixList,
          '',
          'Reply in at most 3 short sentences, plain language, no markdown, no headings.',
          'Say what is wrong using only the findings above, then name exactly one fix id to run first.',
          'If there are no findings, say the check came back clean, do not invent a fault, and suggest one thing to check next.',
          'Do not list fix ids you are not recommending.',
        ].join('\n') });
      }
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
    'Or add ANTHROPIC_API_KEY to config/.env',
  ].join('\n');
  emit({ type: 'token', content: msg });
  emit({ type: 'stream_end' });
  messages.push({ role: 'assistant', content: msg });
  emit({ type: 'done' });
}
