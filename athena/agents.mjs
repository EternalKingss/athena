// agents.mjs -- multi-agent pool + shared workspace
// Phase 16a: CORAL now uses a versioned append-only log.
// Agents pull new broadcasts at turn boundaries -- no forced mid-execution injection.

import { turn, freshMessages, setBroadcastSkill } from './core.mjs';
import { saveAndSummarize } from './memory.mjs';
import { saveSkill, updateSkill, scanSkills, loadSkill } from './skills.mjs';

// ---- Pool ----
// id -> { id, name, status, goal, messages, startedAt, knownSkills, lastCoralVersion }
const pool = new Map();
let nextId = 1;

// ---- Shared workspace ----
const workspace = {};

// ---- CORAL versioned broadcast log (Phase 16a) ----
// Append-only. Each entry has a monotonic version number.
// Agents track lastCoralVersion and pull only new entries at turn boundaries.
let _coralVersion = 0;
const _coralLog = [];  // { version, skillName, description, content, from, at }

export function getCoralLog(sinceVersion = 0) {
  return _coralLog.filter(e => e.version > sinceVersion);
}

export function getCoralVersion() { return _coralVersion; }

function appendCoral(skillName, description, content, from, platform) {
  _coralVersion++;
  _coralLog.push({ version: _coralVersion, skillName, description, content: content || '', from, at: new Date().toISOString(), platform: platform || null });
  if (_coralLog.length > 200) _coralLog.shift();
}

// Called by core.mjs after crystallization (Phase 13).
// No longer injects into running agents -- they pull at turn boundaries.
async function broadcastSkillToAgents(skillName, description, content, emit) {
  appendCoral(skillName, description, content, 'main', process.platform);
  if (emit) emit({ type: 'system', text: 'CORAL v' + _coralVersion + ': skill "' + skillName + '" queued for agent pull' });
}

setBroadcastSkill(broadcastSkillToAgents);

// Pull any CORAL updates since lastCoralVersion and inject as a single batched message.
// Called at the START of each agent turn -- safe boundary, no mid-execution risk.
export function pullCoralUpdates(agent) {
  const allNew = getCoralLog(agent.lastCoralVersion);
  // Filter out platform-specific skills that don't match this agent's platform
  const newEntries = allNew.filter(e => !e.platform || e.platform === process.platform);
  // Always advance version even if all entries were filtered
  if (allNew.length) agent.lastCoralVersion = _coralVersion;
  if (!newEntries.length) return;
  const summary = newEntries.map(e => '- ' + e.skillName + ' (v' + e.version + '): ' + e.description).join('\n');
  agent.messages.push({
    role: 'user',
    content: '[CORAL] ' + newEntries.length + ' new skill(s) available since your last turn:' + '\n' + summary + '\n\nApply these where relevant in this turn.',
  });
  agent.lastCoralVersion = _coralVersion;
}

// ---- Pool accessors ----
export function listAgents() {
  return [...pool.values()].map(a => ({
    id: a.id, name: a.name, status: a.status, goal: a.goal, startedAt: a.startedAt,
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
  workspace[key] = { from: fromName || 'unknown', data, at: new Date().toISOString() };
}

// ---- Spawn ----
export function spawnAgent(name, goal, globalEmit) {
  const id = 'agent-' + (nextId++);
  const messages = freshMessages();
  const knownSkills = new Set();

  // Boot with current CORAL snapshot (all skills known at spawn time)
  const snapshot = getCoralLog(0);
  const coralContext = snapshot.length
    ? '\nCORAL SKILLS (v' + _coralVersion + ') -- available from prior sessions:' + '\n' +
      snapshot.map(e => '- ' + e.skillName + ': ' + e.description).join('\n')
    : '';
  for (const e of snapshot) knownSkills.add(e.skillName);
  const lastCoralVersion = _coralVersion;

  messages.push({
    role: 'user',
    content: [
      'You are a background agent named "' + name + '" running in parallel with other agents.',
      '',
      'Your task:',
      goal,
      '',
      'Guidelines:',
      '- Use workspace_write to post results so the main agent or other agents can see them.',
      '- Use workspace_read to check what other agents have already found -- avoid duplicating work.',
      '- When done, summarize your findings clearly in your final response.',
      coralContext,
    ].join('\n'),
  });

  const agent = {
    id, name, status: 'running', goal, messages,
    startedAt: new Date().toISOString(), knownSkills, lastCoralVersion,
  };
  pool.set(id, agent);
  delete workspace['agent_result_' + name];

  const emit = ev => globalEmit({ ...ev, agentId: id, agentName: name });

  (async () => {
    try {
      // Pass pullCoralUpdates so core.mjs can call it at each turn boundary
      await turn(messages, emit, { isolated: true, onTurnStart: () => pullCoralUpdates(agent) });
      agent.status = 'done';
      const lastMsg = [...messages].reverse().find(m => m.role === 'assistant');
      const finalText = typeof lastMsg?.content === 'string'
        ? lastMsg.content
        : lastMsg?.content?.find?.(b => b.type === 'text')?.text || '';
      if (finalText) {
        workspace['agent_result_' + name] = { from: name, goal, data: finalText, at: new Date().toISOString() };
      }
    } catch (e) {
      agent.status = 'error';
      emit({ type: 'system', text: 'Agent "' + name + '" crashed: ' + e.message });
    }
    saveAndSummarize(messages).catch(() => {});
    emit({ type: 'agent_done', agentId: id, agentName: name, status: agent.status });
  })();

  return id;
}
