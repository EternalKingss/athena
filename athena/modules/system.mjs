// modules/system.mjs -- Module 1: System.
//
// The first module registered with Athena OS. Wraps the existing tool
// surface (tools.mjs's 36 tools + runTool) as a kernel module rather than
// rewriting it -- control_engine.mjs, tools.mjs, and the fix library already
// work and pass their own 14-check selfcheck; this just gives them a front
// door that matches the same contract every future module (browser, email,
// calendar) will use.
//
// Capabilities that report measured machine state are marked authoritative:
// true, generalising the existing rule that L2's readings can be explained
// and prioritised by a model above it, but never contradicted.

import { TOOLS, runTool } from '../tools.mjs';
import { makeCapability } from '../kernel/contract.mjs';

const AUTHORITATIVE = new Set([
  'machine_info',          // hardware/OS/disk/network inventory
  'boot_triage',           // firewall/AV/disk/SSH/updates pass-warn-critical
  'threat_assess',         // 0-100 risk score from measured exposure
  'network_scan',          // interfaces/DNS/ports/routing
  'machine_health_trend',  // direction of travel across past visits
  'machine_diff',          // what changed since last visit on this machine
  'diff_machine_state',    // runtime drift: processes/ports/drivers baseline vs now
  'audit_replay',          // factual record of what Athena actually did
  'machine_fixes',         // inventory of learned/available repairs
]);

function noop() {}

export const systemModule = {
  name: 'system',

  capabilities: TOOLS.map(t => {
    const fn = t.function || t;
    return makeCapability({
      name: fn.name,
      description: fn.description || '',
      authoritative: AUTHORITATIVE.has(fn.name),
    });
  }),

  // Cheap, synchronous proof of life: if TOOLS parsed and is non-empty, the
  // module owning the diagnostic/repair library is importable and intact.
  // Runs at registration and can be re-run any time via runHealthChecks().
  healthCheck() {
    return Array.isArray(TOOLS) && TOOLS.length > 0;
  },

  // Adapts the kernel's (capability, args, ctx) shape onto runTool's existing
  // (name, args, preApproved, sessionTodos, setSessionTodos, requestUserInput)
  // signature -- tools.mjs itself is untouched.
  async execute(capability, args, ctx = {}) {
    const {
      preApproved = false,
      sessionTodos = [],
      setSessionTodos = noop,
      requestUserInput = async () => '',
    } = ctx;
    return runTool(capability, args, preApproved, sessionTodos, setSessionTodos, requestUserInput);
  },
};
