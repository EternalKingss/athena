// kernel/router.mjs -- the central task router (event bus).
//
// dispatch() is the single execution funnel every module call goes through,
// whether the caller is the LLM's normal tool-calling (core.mjs, per-turn) or
// the daemon firing a scheduled goal (kernel/daemon.mjs, on a clock). Goal ->
// capability resolution still happens where it always has -- control_engine's
// deterministic RULES for known symptom phrasings, or the model's own
// tool-calling for everything else. The router's job starts *after* that
// decision is made: given a capability name, find the module that owns it,
// call it, and make sure one broken module can't crash the caller.
//
// dispatch() intentionally returns the same plain string contract runTool()
// has always returned -- core.mjs's downstream logic (loop detection,
// dead-end notes, compressOutput, todo-strip sync) depends on that shape and
// doesn't need to know a kernel exists underneath it. The richer bookkeeping
// (which module handled it, whether the answer was authoritative, when) is
// recorded to an internal audit log as a side effect, not handed back on the
// happy path -- that's what a future UI view or the daemon can read from.

import { findCapabilityOwner, isHealthy } from './registry.mjs';
import { makeEnvelope } from './contract.mjs';

const AUDIT_MAX = 500;

// Last-resort deadline for any module capability. Each module is expected to bound its own
// work (the browser relay times out at 15-20s, Google calls at 30s), so this only fires if
// one of them has a bug. It cannot cancel the module's work -- a promise has no cancel --
// but it gives the turn its answer back so the agent loop keeps moving.
const MODULE_DEADLINE_MS = 120_000;

function withDeadline(promise, ms, capability) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`"${capability}" did not finish within ${Math.round(ms / 1000)}s and was abandoned`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
const auditLog = [];

function record(envelope) {
  auditLog.push(envelope);
  if (auditLog.length > AUDIT_MAX) auditLog.shift();
}

export async function dispatch(capability, args, ctx = {}) {
  const mod = findCapabilityOwner(capability);

  if (!mod) {
    const msg = `Error: no module registered for capability "${capability}"`;
    record(makeEnvelope({ module: null, capability, status: 'error', error: msg }));
    return msg;
  }

  if (!isHealthy(mod.name)) {
    const msg = `Error: module "${mod.name}" is currently disabled (health check failing) -- capability "${capability}" unavailable`;
    record(makeEnvelope({ module: mod.name, capability, status: 'error', error: msg }));
    return msg;
  }

  const capDef = mod.capabilities.find(c => c.name === capability);

  // core.mjs decides approval and passes it as ctx.preApproved. The system module checks
  // it inside runTool; other modules never did, so a browser click the user answered
  // "no" to (a purchase, say) was sent to Chrome anyway. Refuse here, once, for every
  // module. Callers that make no decision at all (no preApproved key) are unaffected.
  if (mod.name !== 'system' && ctx.preApproved === false) {
    const msg = `Error: not approved -- "${capability}" was not run`;
    record(makeEnvelope({ module: mod.name, capability, status: 'error', error: msg }));
    return msg;
  }

  let result;
  try {
    result = mod.name === 'system'
      ? await mod.execute(capability, args, ctx)   // system tools carry their own per-command timeouts, some deliberately long
      : await withDeadline(Promise.resolve().then(() => mod.execute(capability, args, ctx)), MODULE_DEADLINE_MS, capability);
  } catch (e) {
    result = 'Error: ' + e.message;
  }

  const isError = typeof result === 'string' && result.startsWith('Error: ');
  record(makeEnvelope({
    module: mod.name,
    capability,
    status: isError ? 'error' : 'ok',
    data: isError ? null : result,
    error: isError ? result : null,
    authoritative: !!capDef?.authoritative,
  }));

  return result;
}

export function getAuditLog(limit = AUDIT_MAX) {
  return auditLog.slice(-limit);
}

export function clearAuditLog() {
  auditLog.length = 0;
}
