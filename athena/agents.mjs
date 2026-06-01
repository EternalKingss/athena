// agents.mjs — multi-agent pool + shared workspace
// Agents run in parallel, each with their own message history.
// They communicate via the shared workspace (in-memory key/value store).

import { turn, freshMessages } from './core.mjs';
import { saveAndSummarize } from './memory.mjs';

// ---- Pool ----
// id → { id, name, status, goal, messages, startedAt }
const pool = new Map();
let nextId = 1;

// ---- Shared workspace ----
// key → { from, data, at }
const workspace = {};

// ---- Pool accessors ----
export function getPool() { return pool; }

export function listAgents() {
  return [...pool.values()].map(a => ({
    id:        a.id,
    name:      a.name,
    status:    a.status,
    goal:      a.goal,
    startedAt: a.startedAt,
  }));
}

// ---- Workspace accessors ----
export function workspaceRead(keyPrefix) {
  if (!keyPrefix) return { ...workspace };
  const out = {};
  for (const [k, v] of Object.entries(workspace)) {
    if (k.startsWith(keyPrefix)) out[k] = v;
  }
  return out;
}

export function workspaceWrite(key, data, fromName) {
  workspace[key] = {
    from: fromName || 'unknown',
    data,
    at: new Date().toISOString(),
  };
}

// ---- Spawn ----
// globalEmit: the emit function from the caller (cli or ui broadcast).
// Returns the new agent's id immediately; work runs in background.
export function spawnAgent(name, goal, globalEmit) {
  const id = `agent-${nextId++}`;
  const messages = freshMessages();

  // Prime agent with its task + workspace context
  messages.push({
    role: 'user',
    content: [
      `You are a background agent named "${name}" running in parallel with other agents.`,
      ``,
      `Your task:`,
      goal,
      ``,
      `Guidelines:`,
      `- Use workspace_write to post results so the main agent or other agents can see them.`,
      `- Use workspace_read to check what other agents have already found — avoid duplicating work.`,
      `- When done, summarize your findings clearly in your final response.`,
    ].join('\n'),
  });

  const agent = { id, name, status: 'running', goal, messages, startedAt: new Date().toISOString() };
  pool.set(id, agent);

  // Clear any previous result from an agent with the same name so stale data doesn't accumulate
  delete workspace[`agent_result_${name}`];

  // Tag all events from this agent with its id/name
  const emit = ev => globalEmit({ ...ev, agentId: id, agentName: name });

  // Run async — does not block the caller
  (async () => {
    try {
      await turn(messages, emit, { isolated: true });
      agent.status = 'done';

      // Auto-post final answer to workspace so Athena can see it without being asked
      const lastMsg = [...messages].reverse().find(m => m.role === 'assistant');
      const finalText = typeof lastMsg?.content === 'string'
        ? lastMsg.content
        : lastMsg?.content?.find?.(b => b.type === 'text')?.text || '';
      if (finalText) {
        workspace[`agent_result_${name}`] = {
          from: name,
          goal,
          data: finalText,
          at: new Date().toISOString(),
        };
      }
    } catch (e) {
      agent.status = 'error';
      emit({ type: 'system', text: `Agent "${name}" crashed: ${e.message}` });
    }
    // Persist the agent's session so its work isn't lost
    saveAndSummarize(messages).catch(() => {});
    emit({ type: 'agent_done', agentId: id, agentName: name, status: agent.status });
  })();

  return id;
}
