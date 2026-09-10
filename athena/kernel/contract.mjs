// kernel/contract.mjs -- the uniform protocol every Athena OS module speaks.
//
// This generalises the fix contract (detect/steps/verify) that tools.mjs already
// trusts for repairs, one layer up: every module declares its capabilities up
// front and every result is wrapped the same way, regardless of which module
// produced it. A module that doesn't match this shape fails at registration --
// loud and immediate -- rather than the first time something tries to dispatch
// to it.

const REQUIRED_MODULE_FIELDS = ['name', 'capabilities', 'execute'];

export class ContractViolation extends Error {
  constructor(msg) { super(msg); this.name = 'ContractViolation'; }
}

// A capability declaration. `authoritative: true` means this capability
// returns measured fact, not opinion -- the existing L2 rule ("L2 state truth
// is immutable; L3/L4 may only annotate, not contradict") generalised to any
// module, not just the system one. Diagnostics/reads are authoritative;
// actions (repairs, sends, applies) are not -- they're things that happened,
// not facts to be overruled.
//
// `parameters` is the JSON-schema-shaped argument description handed to the
// model (mirrors tools.mjs's existing per-tool `parameters` shape) -- optional
// because a capability with no arguments doesn't need one.
//
// `localOk` defaults to true: most capabilities are fine to expose to local
// models. Set it false for anything that shouldn't be handed to a small local
// model's tool surface (e.g. something expensive, or something that needs
// judgement a local model tends to get wrong) without touching every other
// capability's declaration to opt in.
export function makeCapability({ name, description = '', authoritative = false, parameters = null, localOk = true }) {
  if (!name || typeof name !== 'string') {
    throw new ContractViolation('capability needs a string name');
  }
  return { name, description, authoritative: !!authoritative, parameters: parameters ?? null, localOk: localOk !== false };
}

// Validates a module object before it's allowed into the registry.
export function validateModule(mod) {
  if (!mod || typeof mod !== 'object') {
    throw new ContractViolation('module must be an object');
  }
  for (const f of REQUIRED_MODULE_FIELDS) {
    if (!(f in mod)) throw new ContractViolation(`module "${mod.name || '?'}" missing required field "${f}"`);
  }
  if (typeof mod.name !== 'string' || !mod.name) {
    throw new ContractViolation('module.name must be a non-empty string');
  }
  if (!Array.isArray(mod.capabilities) || mod.capabilities.length === 0) {
    throw new ContractViolation(`module "${mod.name}" must declare at least one capability`);
  }
  for (const cap of mod.capabilities) {
    if (!cap || typeof cap.name !== 'string' || !cap.name) {
      throw new ContractViolation(`module "${mod.name}" has a capability with no name`);
    }
  }
  if (typeof mod.execute !== 'function') {
    throw new ContractViolation(`module "${mod.name}".execute must be a function`);
  }
  if (mod.healthCheck !== undefined && typeof mod.healthCheck !== 'function') {
    throw new ContractViolation(`module "${mod.name}".healthCheck must be a function if present`);
  }
  return true;
}

// The kernel's private bookkeeping envelope -- audit trail + authoritative
// tracking. NOT what core.mjs's live tool-call site receives back; that path
// keeps getting the plain string runTool() has always returned, so existing
// loop detection, dead-end notes, and compressOutput are untouched. This is
// the ledger, not the wire format to the model.
export function makeEnvelope({ module, capability, status, data, error, authoritative }) {
  return {
    module,
    capability,
    status: status === 'error' ? 'error' : 'ok',
    data: data ?? null,
    error: error ?? null,
    authoritative: !!authoritative,
    at: new Date().toISOString(),
  };
}
