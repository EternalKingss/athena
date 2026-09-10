// modules/browser.mjs -- Module 2: Browser.
//
// Gives Athena capabilities inside the user's real, already-logged-in
// Chrome -- not a spun-off automation profile -- through a Manifest V3
// extension (extension/) that talks to modules/browser/relay.mjs over
// plain HTTP polling. This file owns only the kernel-facing side: it
// declares capabilities and turns each dispatch() call into a relay
// command, then waits for the extension's answer.
//
// Isolation, by construction: this file imports nothing from
// modules/system.mjs or tools.mjs, and nothing in Module 1 imports this
// file or modules/browser/relay.mjs. The only thing Module 1 and Module 2
// share is the kernel itself (registry/router/daemon) and the LLM/turn
// loop in core.mjs -- exactly the boundary asked for, nothing more.

import { makeCapability } from '../kernel/contract.mjs';
import { submitCommand, isListening, isExtensionConnected } from './browser/relay.mjs';

// Screenshots are a heavier round-trip (base64 image payload) than the
// other actions and not something a small local model should be reaching
// for by default -- localOk: false keeps it out of the local tool surface
// without touching any other capability's declaration.
const CAP_DEFS = [
  {
    name: 'browser_navigate',
    description: 'Navigate a browser tab to a URL, in the user\'s real signed-in Chrome. Omit tabId to open (or reuse) Athena\'s own dedicated working tab -- this never touches or steals the user\'s actual active tab. Pass an explicit tabId (e.g. one returned by browser_list_tabs) to navigate a specific existing tab instead.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' }, tabId: { type: 'number', description: 'Optional. Leave this out entirely to get a new (or Athena\'s existing working) tab -- never pass -1 or any other placeholder value to mean "new tab". Pass a real tabId from browser_list_tabs only when you want to navigate a specific existing tab.' } },
      required: ['url'],
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element on the page, identified by a CSS selector or its visible text.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        text: { type: 'string', description: 'Visible text to match if no selector is given.' },
        tabId: { type: 'number' },
      },
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into a focused or selected input field on the page.',
    parameters: {
      type: 'object',
      properties: { selector: { type: 'string' }, text: { type: 'string' }, tabId: { type: 'number' } },
      required: ['text'],
    },
  },
  {
    name: 'browser_read_text',
    description: 'Read the visible text content of the active (or a specified) tab.',
    authoritative: true, // measured fact about what's on the page right now, not opinion
    parameters: { type: 'object', properties: { tabId: { type: 'number' } } },
  },
  {
    name: 'browser_screenshot',
    description: 'Capture a screenshot of the active (or a specified) tab.',
    authoritative: true,
    localOk: false,
    parameters: { type: 'object', properties: { tabId: { type: 'number' } } },
  },
  {
    name: 'browser_list_tabs',
    description: 'List currently open browser tabs (title, url, id).',
    authoritative: true,
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'browser_status',
    description: 'Report whether the browser extension is currently connected and reachable.',
    authoritative: true,
    parameters: { type: 'object', properties: {} },
  },
];

// browser_status is answered locally -- it's a fact about the relay itself,
// not something the extension needs to be asked about.
async function handleStatus() {
  return JSON.stringify({ extensionConnected: isExtensionConnected() });
}

export const browserModule = {
  name: 'browser',

  capabilities: CAP_DEFS.map(makeCapability),

  // Health here means "the relay is up and can accept commands," not "the
  // extension happens to be connected right now" -- an extension that
  // hasn't been installed/opened yet shouldn't make the whole module look
  // broken, the same way module 1 doesn't go unhealthy just because a
  // particular tool has nothing to report yet.
  healthCheck() {
    return isListening();
  },

  async execute(capability, args = {}, ctx = {}) {
    if (capability === 'browser_status') return handleStatus();
    const result = await submitCommand(capability, args, {
      timeoutMs: capability === 'browser_screenshot' ? 20_000 : undefined,
    });
    return typeof result === 'string' ? result : JSON.stringify(result);
  },
};
