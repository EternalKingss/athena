// agent_loop.mjs -- shared bounded, risk-gated, verified tool-calling loop
// against a specific model.
//
// One implementation, two callers: tools.mjs's delegate_to_local tool (Claude
// handing a single subtask to a local model mid-turn) and task_router.mjs (routing an
// entire turn to a local model before Claude is ever invoked, to avoid the
// API cost for something obviously mechanical). Both need the exact same
// guarantee -- every tool call actually executes for real through the kernel,
// gets risk-checked before it runs, and "the model talked about doing
// something but never called a tool" is treated as failure, not success --
// so that guarantee lives here once instead of twice.

import { chatStream } from './api.mjs';
import { dispatch } from './kernel/router.mjs';
import { toolsForModel } from './kernel/toolSurface.mjs';
import { classifyRisk, irreversibleReason } from './tools.mjs';
import { loadFingerprint } from './machines.mjs';

// Runs `task` against `model` (an OpenAI-compatible model id -- almost
// always a local-* model, but nothing here assumes that) for up to
// `maxSteps` tool-call rounds. Returns:
//   { ok: true,  model, actionsExecuted, finalText }
//   { ok: false, model, actionsExecuted, failureReason, finalText? }
// actionsExecuted is always populated with whatever DID get dispatched
// before a failure, so a caller can show partial progress even on failure.
export async function runBoundedAgentLoop({ model, systemPrompt, task, maxSteps = 6 }) {
  const tools = toolsForModel(model);
  const machineProfile = loadFingerprint();
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
  ];

  const actionsExecuted = [];
  let sawAnyToolCall = false;

  for (let step = 0; step < maxSteps; step++) {
    let textContent = '';
    const toolCallMap = {};

    try {
      for await (const chunk of chatStream(messages, tools, { model })) {
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) textContent += delta.content;
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const slot = (toolCallMap[tc.index] ??= { id: '', name: '', args: '' });
            if (tc.id)                  slot.id   += tc.id;
            if (tc.function?.name)      slot.name += tc.function.name;
            if (tc.function?.arguments) slot.args += tc.function.arguments;
          }
        }
      }
    } catch (e) {
      return { ok: false, model, actionsExecuted, failureReason: 'model call failed: ' + e.message };
    }

    const calls = Object.values(toolCallMap);
    const msg = { role: 'assistant', content: textContent || null };
    if (calls.length) {
      msg.tool_calls = calls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } }));
    }
    messages.push(msg);

    if (!calls.length) {
      // The model stopped calling tools. Only success if it actually did
      // something first -- otherwise this is exactly the "said it would
      // act, didn't" failure mode this loop exists to catch.
      if (!sawAnyToolCall) {
        return {
          ok: false, model, actionsExecuted,
          failureReason: 'produced no tool calls -- described a plan instead of acting on it',
          finalText: textContent || null,
        };
      }
      return { ok: true, model, actionsExecuted, finalText: textContent || null };
    }

    sawAnyToolCall = true;
    const toolResults = [];
    for (const tc of calls) {
      let parsedArgs = {};
      try { parsedArgs = JSON.parse(tc.args || '{}'); } catch {}

      const risk = classifyRisk(tc.name, parsedArgs, machineProfile);
      const badReason = irreversibleReason(tc.name, parsedArgs);
      if (risk.tier >= 2 || badReason) {
        return {
          ok: false, model, actionsExecuted,
          failureReason: `attempted "${tc.name}", above the risk level this loop allows (${badReason || risk.reason})`,
        };
      }

      let result;
      try {
        result = await dispatch(tc.name, parsedArgs, {
          preApproved: true, sessionTodos: [], setSessionTodos: () => {},
          requestUserInput: async () => '',
        });
      } catch (e) {
        result = 'Error: ' + e.message;
      }
      actionsExecuted.push({ name: tc.name, args: parsedArgs, result });
      toolResults.push({ role: 'tool', tool_call_id: tc.id, content: String(result) });
    }
    messages.push(...toolResults);
  }

  return {
    ok: false, model, actionsExecuted,
    failureReason: `hit the ${maxSteps}-step limit before finishing on its own`,
  };
}
