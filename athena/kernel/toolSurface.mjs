// kernel/toolSurface.mjs -- the model-facing tool list, kernel-wide.
//
// tools.mjs's toolsForModel() only ever knew about Module 1's 36 tools --
// dispatch() can already route to any registered module's capabilities, but
// nothing merged those capabilities into what actually gets handed to the
// model. A capability a module registers is dispatchable in principle and
// invisible in practice, until this file exists -- the same shape of bug as
// the earlier "Claude was never actually being used" failure, one layer up.
//
// This is the ONLY shared surface Module 2 (or any future module) needs from
// Module 1: it reads Module 1's own toolsForModel() output and the kernel
// registry, and merges them. It does not import modules/system.mjs, and
// modules/system.mjs does not import this file or any other module --
// isolation stays intact; this is kernel-level plumbing, not module code.

import { toolsForModel as systemToolsForModel } from '../tools.mjs';
import { listModules, getModule, isHealthy } from './registry.mjs';

// Builds one OpenAI-shaped tool entry from a kernel capability declaration.
function toOpenAiTool(cap) {
  return {
    type: 'function',
    function: {
      name: cap.name,
      description: cap.description || '',
      parameters: cap.parameters || { type: 'object', properties: {} },
    },
  };
}

// Returns the full, current, model-facing tool list: Module 1's own list
// (unchanged -- it already knows how to shrink itself for local models) plus
// every OTHER healthy registered module's capabilities, each converted to
// the same OpenAI tool shape. `localOk: false` capabilities are excluded
// when `model` is a local model, mirroring tools.mjs's own local subsetting.
export function toolsForModel(model) {
  const base = systemToolsForModel(model);
  const isLocal = !!model && String(model).startsWith('local-');

  const extra = [];
  for (const { name } of listModules()) {
    if (name === 'system') continue;           // already covered by `base`
    if (!isHealthy(name)) continue;             // unhealthy modules stay invisible, same as dispatch() refusing them
    const mod = getModule(name);
    if (!mod) continue;
    for (const cap of mod.capabilities) {
      if (isLocal && cap.localOk === false) continue;
      extra.push(toOpenAiTool(cap));
    }
  }

  return extra.length ? [...base, ...extra] : base;
}
