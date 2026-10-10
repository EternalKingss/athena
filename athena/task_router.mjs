// task_router.mjs -- pre-Claude cost gate.
//
// Runs BEFORE core.mjs's normal turn loop touches any cloud model. A cheap,
// free (no API call, no local-model call either) heuristic decides whether
// an incoming message is obviously basic and mechanical enough to attempt
// entirely on a local model -- no Claude call for that turn at all, not even
// to decide. Anything the heuristic isn't confident about falls straight
// through to the normal turn loop (Claude, or whichever model is active),
// exactly as if this file didn't exist.
//
// Fails open, never closed: if the local attempt doesn't actually finish the
// job -- no tool calls, an error, the step cap, or no local model exists at
// all -- this reports "not handled" and the caller runs the normal turn
// afterward. The user always ends up with a working answer; this only ever
// saves money, it never blocks or degrades a task. The only cost of a wrong
// "try local" guess is a few seconds of local compute before the normal
// (Claude) turn kicks in -- there is no double Claude spend and no broken
// response, because nothing from the failed attempt is kept.

import { runBoundedAgentLoop } from './agent_loop.mjs';
import { pickLocalModelId } from './local_llm.mjs';

const MAX_STEPS = 8;

// Deliberately conservative about what counts as "clearly needs Claude" --
// this heuristic only has to catch the OBVIOUS local candidates. A miss
// (something basic that doesn't match) just means normal Claude behaviour,
// not a wrong answer, so there is no pressure to make this exhaustive.
const NEEDS_REASONING = /\b(why|analy[sz]e|compare|design|plan|architect|strategy|should i|what do you think|recommend|explain|write (me |us )?(a|an|the)\b)/i;
// Diagnosing and fixing always go to Claude (v3.4), however short the request.
const NEEDS_CLAUDE = /\b(fix|repair|diagnos\w*|scan|troubleshoot|broken|not working|doesn'?t work|won'?t|crash\w*|error|slow|virus|malware|clean ?up|install|uninstall|update|driver|disk|drive|memory|cpu|wi-?fi|network|internet)\b/i;
const ACTION_VERBS = /\b(click|press|play|pause|resume|skip|next track|previous track|mute|unmute|volume|louder|quieter|turn (it |the volume )?(up|down)|navigate|go to|open\s.{0,20}\b(tab|page|site|browser)\b|type|read (the|this) (page|tab)|screenshot|list (the )?(open )?tabs|find the tab|check (the )?tab|switch to (the )?tab)\b/i;

// Exported so selfcheck can unit-test the classifier directly, with no live
// model involved -- same spirit as control_engine.mjs's detectIntents tests.
export function looksBasic(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 220) return false;        // long messages are rarely one mechanical step
  if (NEEDS_REASONING.test(s)) return false;       // judgment/reasoning language -- send to Claude
  if (NEEDS_CLAUDE.test(s)) return false;          // diagnosing / fixing -- Claude only
  if (/[.!?].{20,}[.!?]/.test(s)) return false;    // more than one real sentence -- likely multi-part
  return ACTION_VERBS.test(s);
}

const ROUTER_SYSTEM_PROMPT =
  "You are Athena, answering directly -- the person does not know a local " +
  "model is handling this instead of the main assistant, so respond exactly " +
  "as Athena would, in first person, with no meta-commentary about being " +
  "local or a subtask. Use your tools to actually carry out what was asked; " +
  "do not just describe what you would do. When done, reply with a normal, " +
  "short confirmation.";

// True when the turn before this message was Claude doing tool work. The local
// model only ever sees the newest message, with no history, so a follow-up like
// "just open a normal tab" in the middle of a Claude browser task reached it
// stripped of everything it referred to -- and it opened google.com. Local
// turns never leave tool_calls in the history (only their final text), so a
// tool_calls message between the previous user message and this one means
// Claude was mid-task, and the follow-up stays with Claude.
export function isFollowUpToClaudeTask(messages = []) {
  let i = messages.length - 1;
  while (i >= 0 && messages[i].role !== 'user') i--;     // the current message
  for (i--; i >= 0 && messages[i].role !== 'user'; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) return true;
  }
  return false;
}

// emit is the same event-callback turn() already threads through everywhere
// else -- this just adds a couple of 'system' notices so it's visible in the
// transcript when a message got routed locally instead of costing Claude.
export async function tryLocalFirst(userText, emit) {
  if (!looksBasic(userText)) return { handled: false };

  const modelId = await pickLocalModelId();
  if (!modelId) return { handled: false }; // nothing to route to -- normal turn proceeds

  emit({ type: 'system', text: 'Looks routine -- trying it on ' + modelId + ' first (no Claude call yet).' });

  let result;
  try {
    result = await runBoundedAgentLoop({
      model: modelId,
      systemPrompt: ROUTER_SYSTEM_PROMPT,
      task: userText,
      maxSteps: MAX_STEPS,
    });
  } catch (e) {
    result = { ok: false, failureReason: 'router loop threw: ' + e.message };
  }

  if (!result.ok) {
    emit({ type: 'system', text: "Local attempt didn't finish it (" + result.failureReason + ') -- handing to Claude.' });
    return { handled: false };
  }

  emit({ type: 'system', text: 'Handled locally on ' + modelId + ' -- no Claude call for this one.' });
  return { handled: true, finalText: result.finalText, actionsExecuted: result.actionsExecuted, model: modelId };
}
