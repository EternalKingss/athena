// kernel/index.mjs -- Athena OS. Her head.
//
// A micro-kernel: this file's only job is to sit at the top, hold the
// registry/router/daemon together, and expose one surface for everything
// above it (core.mjs's live tool-calling, the daemon's scheduled goals,
// eventually a UI view) to talk to modules through. It holds no domain
// logic of its own -- Module 1 (system) still owns diagnostics and repairs,
// Module 2 (browser) still owns its relay and extension protocol; this just
// gives each of them, and everything registered after them, a common front
// door. Modules never import each other here or anywhere else -- the only
// thing they share is this file's registry/router/daemon and the LLM/turn
// loop above it in core.mjs.
//
// Model routing (which brain -- local or cloud -- actually does a subtask)
// is deliberately NOT a module here: it's core OS plumbing, not a pluggable
// capability domain, so delegate_to_local lives in tools.mjs alongside the
// rest of the built-in tool surface instead of being registered as its own
// module.

import {
  registerModule, runHealthChecks, listModules, listCapabilities,
  getModule, isHealthy, _resetRegistryForTests,
} from './registry.mjs';
import { dispatch, getAuditLog, clearAuditLog } from './router.mjs';
import { scheduleTask, cancelTask, listScheduled, tick, startDaemon } from './daemon.mjs';
import { systemModule } from '../modules/system.mjs';
import { browserModule } from '../modules/browser.mjs';
import { googleModule } from '../modules/google.mjs';
import { startRelay } from '../modules/browser/relay.mjs';
import { BROWSER_RELAY_PORT } from '../config.mjs';

let _booted = false;
let _stopDaemon = null;

// Boots the kernel: starts each module's own resources, registers every
// known module, runs the initial health sweep, and starts the heartbeat.
// Idempotent -- calling it twice (e.g. a stray double-import) doesn't try
// to re-register modules and throw.
export function bootKernel({ startHeartbeat = true, intervalMs = 60_000 } = {}) {
  if (_booted) return getKernelSurface(runHealthChecks());

  // The relay has to be listening before browserModule registers, so its
  // healthCheck (which asks the relay, not the extension) sees it up.
  startRelay({ port: BROWSER_RELAY_PORT });

  registerModule(systemModule);
  registerModule(browserModule);
  registerModule(googleModule);
  // Future modules register here, same call, same contract:
  //   registerModule(correspondenceModule);

  const bootHealth = runHealthChecks();
  _booted = true;

  if (startHeartbeat) _stopDaemon = startDaemon({ intervalMs });

  return getKernelSurface(bootHealth);
}

export function stopKernel() {
  if (_stopDaemon) { _stopDaemon(); _stopDaemon = null; }
  _booted = false;
}

export function isBooted() { return _booted; }

function getKernelSurface(bootHealth) {
  return {
    dispatch,
    scheduleTask,
    cancelTask,
    listScheduled,
    tick,
    listModules,
    listCapabilities,
    getModule,
    isHealthy,
    runHealthChecks,
    getAuditLog,
    clearAuditLog,
    bootHealth,
  };
}

// Test hook only -- lets selfcheck.mjs boot a clean kernel per-check without
// stray module state leaking between checks in the same process. Never
// called from a live boot path. Deliberately does NOT stop the browser
// relay: it's a real listening socket (unref'd, idempotent to start), and
// tearing it down and rebinding it between every single check invites a
// port race that has nothing to do with what these checks are testing.
export function _resetKernelForTests() {
  if (_stopDaemon) { _stopDaemon(); _stopDaemon = null; }
  _booted = false;
  _resetRegistryForTests();
  clearAuditLog();
}
