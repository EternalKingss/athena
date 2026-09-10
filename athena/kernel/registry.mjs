// kernel/registry.mjs -- module registry & lifecycle manager.
//
// Keeps track of which modules are registered, which capability belongs to
// which module, and whether each module is currently healthy. A module that
// fails its health check is marked disabled rather than crashing the whole
// assistant -- the router refuses to dispatch to it and says so, same
// philosophy as the rest of Athena: a known "unknown"/"unavailable" beats a
// silent wrong answer.

import { validateModule } from './contract.mjs';

const modules = new Map();          // name -> module object
const capabilityOwner = new Map();  // capability name -> module name
const health = new Map();           // module name -> { ok, checkedAt, error }

export function registerModule(mod) {
  validateModule(mod); // throws ContractViolation loudly if malformed -- no silent partial registration

  if (modules.has(mod.name)) {
    throw new Error(`module "${mod.name}" is already registered`);
  }

  // Capability names are globally unique across modules. Two modules
  // claiming the same capability is a registration bug to surface now, not
  // something where the last one in silently wins.
  for (const cap of mod.capabilities) {
    if (capabilityOwner.has(cap.name)) {
      throw new Error(
        `capability "${cap.name}" is already owned by module "${capabilityOwner.get(cap.name)}" -- ` +
        `"${mod.name}" cannot also claim it`
      );
    }
  }

  modules.set(mod.name, mod);
  for (const cap of mod.capabilities) capabilityOwner.set(cap.name, mod.name);

  runHealthCheck(mod.name);
  return true;
}

export function unregisterModule(name) {
  const mod = modules.get(name);
  if (!mod) return false;
  for (const cap of mod.capabilities) capabilityOwner.delete(cap.name);
  modules.delete(name);
  health.delete(name);
  return true;
}

// Runs one module's health check. No healthCheck defined = assumed healthy
// (not every module needs one). A throwing or falsy healthCheck marks the
// module disabled -- dispatch() then refuses to route to it instead of
// calling a known-broken module and hoping.
export function runHealthCheck(name) {
  const mod = modules.get(name);
  if (!mod) return { ok: false, checkedAt: new Date().toISOString(), error: `no module named "${name}"` };
  let ok, error = null;
  try {
    ok = mod.healthCheck ? !!mod.healthCheck() : true;
    if (!ok) error = 'healthCheck returned falsy';
  } catch (e) {
    ok = false;
    error = e.message;
  }
  const entry = { ok, checkedAt: new Date().toISOString(), error };
  health.set(name, entry);
  return entry;
}

export function runHealthChecks() {
  const report = {};
  for (const name of modules.keys()) report[name] = runHealthCheck(name);
  return report;
}

export function isHealthy(name) {
  if (!modules.has(name)) return false;
  return health.get(name)?.ok !== false;
}

export function getModule(name) { return modules.get(name) || null; }

export function findCapabilityOwner(capability) {
  const modName = capabilityOwner.get(capability);
  return modName ? modules.get(modName) : null;
}

export function getCapability(capability) {
  const mod = findCapabilityOwner(capability);
  if (!mod) return null;
  return mod.capabilities.find(c => c.name === capability) || null;
}

export function listModules() {
  return [...modules.values()].map(m => ({
    name: m.name,
    capabilities: m.capabilities.map(c => c.name),
    healthy: isHealthy(m.name),
  }));
}

export function listCapabilities() {
  return [...capabilityOwner.entries()].map(([capability, module]) => ({ capability, module }));
}

// Test hook only -- selfcheck.mjs runs the registry fresh without restarting
// the process. Not called from any live boot path.
export function _resetRegistryForTests() {
  modules.clear();
  capabilityOwner.clear();
  health.clear();
}
