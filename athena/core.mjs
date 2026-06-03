// core.mjs — turn loop, task runner, context compression
import { chat, chatStream } from './api.mjs';
import { TOOLS, DESTRUCTIVE, runTool } from './tools.mjs';
import { systemPrompt } from './personality.mjs';
import { AUTO } from './config.mjs';
import { compressOutput } from './compress.mjs';

// ---- Session state ----
// These are scoped to the MAIN agent only.
// Background agents get their own isolated todos (passed via turn() closure).
let SESSION_TODOS = [];
export let _requestUserInput = null; // set by CLI or UI runner

export function setRequestUserInput(fn) { _requestUserInput = fn; }
export function getSessionTodos() { return SESSION_TODOS; }
export function setSessionTodos(t) { SESSION_TODOS = t; }

// Background agents get a no-op clarify so they never block waiting for user input
const _noopInput = async (question) => `(background agent — cannot ask user: ${question})`;


// ---- Context compression ----
const COMPRESS_AT        = 40;
const COMPRESS_KEEP_START = 4;
const COMPRESS_KEEP_END   = 10;

export async function maybeCompress(messages, emit, currentTodos = []) {
  if (messages.length < COMPRESS_AT) return;
  const start  = messages.slice(0, COMPRESS_KEEP_START);
  const end    = messages.slice(-COMPRESS_KEEP_END);
  const middle = messages.slice(COMPRESS_KEEP_START, -COMPRESS_KEEP_END);
  if (middle.length < 6) return;

  emit({ type: 'system', text: `Compressing ${middle.length} messages to stay within context…` });
  try {
    const sum = await chat([
      { role: 'system', content: 'Summarize this conversation in 10-15 bullet points. Be specific: include filenames, commands, values, decisions, problems solved, current state. No preamble.' },
      { role: 'user', content: middle.filter(m => m.role === 'user' || m.role === 'assistant').map(m => `${m.role}: ${m.content || '[tool]'}`).join('\n') },
    ]);
    const summary = { role: 'assistant', content: `[Context compressed — ${middle.length} messages → summary]\n${sum.content || ''}` };
    const todoReinject = currentTodos.length
      ? [{ role: 'user', content: `[Task list after compression]\n${JSON.stringify(currentTodos)}` }]
      : [];
    messages.length = 0;
    messages.push(...start, summary, ...todoReinject, ...end);
    emit({ type: 'system', text: `Compressed (${middle.length} → 1). Continuing…` });
  } catch { /* non-fatal */ }
}

// ---- Core turn loop ----
// opts.isolated = true → use private todos + no-op clarify (for background agents)
export async function turn(messages, emit, opts = {}) {
  emit({ type: 'status', text: 'thinking' });

  // Isolated agents get their own todo list and a no-op input handler
  // so they never block or interfere with the main agent's state
  let agentTodos = opts.isolated ? [] : SESSION_TODOS;
  const setAgentTodos = opts.isolated ? (t => { agentTodos = t; }) : setSessionTodos;
  const inputHandler  = opts.isolated ? _noopInput : _requestUserInput;

  await maybeCompress(messages, emit, agentTodos);

  const MAX_TOOL_ITERATIONS = 50;
  let toolIterations = 0;
  while (true) {
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

    if (!msg.tool_calls?.length) { emit({ type: 'done' }); return; }
    toolIterations++;

    // ---- Execute tool calls ----
    const calls = msg.tool_calls.map(call => {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
      return { call, args };
    });

    // Destructive approval: background agents auto-approve (they run unattended)
    let batchApproved = AUTO || opts.isolated;
    if (!batchApproved && process.env.ATHENA_UI !== '1') {
      const destructive = calls.filter(({ call }) => DESTRUCTIVE.has(call.function.name));
      if (destructive.length) {
        emit({ type: 'approval_request', calls: destructive.map(({ call, args }) => ({
          name: call.function.name, preview: args.command || args.path || JSON.stringify(args).slice(0, 80),
        }))});
        batchApproved = await cliApprove(destructive, emit);
      }
    }

    const toolResults = [];
    for (const { call, args } of calls) {
      const isDestructive = DESTRUCTIVE.has(call.function.name);
      emit({ type: 'tool_start', name: call.function.name, args });
      let result;
      try {
        result = await runTool(
          call.function.name, args,
          batchApproved || !isDestructive,
          agentTodos, setAgentTodos, inputHandler
        );
      } catch (e) {
        result = `Error: ${e.message}`;
      }
      emit({ type: 'tool_result', name: call.function.name, result });
      const compressed = compressOutput(String(result), call.function.name);
      toolResults.push({ role: 'tool', tool_call_id: call.id, content: compressed });
    }
    messages.push(...toolResults);
  }
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
export async function runTask(goal, messages, emit) {
  emit({ type: 'system', text: `Task: ${goal}` });
  const taskMsg = {
    role: 'user',
    content: `You are now running in autonomous task mode.\n\nGoal: ${goal}\n\nPlan your approach using the todo tool, then execute step by step. Report progress after each step. When finished, summarize what was accomplished.`,
  };
  messages.push(taskMsg);
  await turn(messages, emit);
}

// ---- Fresh message array factory ----
export function freshMessages() {
  return [{ role: 'system', content: systemPrompt() }];
}
