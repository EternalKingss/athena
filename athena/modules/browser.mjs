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
import { PURCHASE_LIKE } from '../kernel/risk_patterns.mjs';
import { submitCommand, isListening, isExtensionConnected } from './browser/relay.mjs';

// Screenshots are a heavier round-trip (base64 image payload) than the
// other actions and not something a small local model should be reaching
// for by default -- localOk: false keeps it out of the local tool surface
// without touching any other capability's declaration. The same goes for the
// snapshot/ref workflow and the finer-grained input tools: the local model
// handles basic commands only, and those stay exactly as they were.
const TAB = { type: 'number', description: 'Optional. Defaults to Athena\'s working tab.' };
const REF = { type: 'number', description: 'Element ref from the latest browser_snapshot, e.g. 12 for "[12] button ...".' };

const CAP_DEFS = [
  {
    name: 'browser_navigate',
    description: 'Navigate a browser tab to a URL, in the user\'s real signed-in Chrome. Omit tabId to open (or reuse) Athena\'s own dedicated working tab -- this never touches or steals the user\'s actual active tab. Pass an explicit tabId (e.g. one returned by browser_list_tabs) to navigate a specific existing tab instead. Follow with browser_wait, then browser_snapshot to see what is on the page.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' }, tabId: { type: 'number', description: 'Optional. Leave this out entirely to get a new (or Athena\'s existing working) tab -- never pass -1 or any other placeholder value to mean "new tab". Pass a real tabId from browser_list_tabs only when you want to navigate a specific existing tab.' } },
      required: ['url'],
    },
  },
  {
    name: 'browser_snapshot',
    description: 'List the clickable and typeable elements on the page, one per line with a ref number: [12] button "Send", [13] textbox "Search" value="cats". Use the ref with browser_click / browser_type / browser_key / browser_scroll -- the most reliable way to act on a page. Refs stay valid until the page changes; take a new snapshot after anything that changes the page.',
    authoritative: true,
    localOk: false,
    parameters: {
      type: 'object',
      properties: {
        viewportOnly: { type: 'boolean', description: 'Only list elements currently on screen (shorter output). Default false.' },
        tabId: TAB,
      },
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element with a real mouse click (the page cannot tell it from a person). Target it by ref from browser_snapshot (preferred), a CSS selector, or its visible text. Clicking something that looks like a purchase or checkout asks the user first.',
    parameters: {
      type: 'object',
      properties: {
        ref: REF,
        selector: { type: 'string' },
        text: { type: 'string', description: 'Visible text to match when no ref/selector is given. With a ref, it must match that element\'s label (a safety check).' },
        tabId: TAB,
      },
    },
  },
  {
    name: 'browser_click_at',
    description: 'Real mouse click at x/y pixel coordinates of the latest browser_screenshot image. Fallback for things browser_snapshot does not list (canvas, maps, custom widgets) -- prefer browser_click with a ref.',
    localOk: false,
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Pixels from the left edge of the screenshot image.' },
        y: { type: 'number', description: 'Pixels from the top edge of the screenshot image.' },
        text: { type: 'string', description: 'Optional label of what you expect at that spot; the click is refused if it does not match.' },
        tabId: TAB,
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into a field. Target it by ref (preferred) or selector; with neither, types into whatever is focused. clear: true replaces the field\'s current contents instead of appending.',
    parameters: {
      type: 'object',
      properties: {
        ref: REF,
        selector: { type: 'string' },
        text: { type: 'string' },
        clear: { type: 'boolean', description: 'Replace existing contents. Default false.' },
        tabId: TAB,
      },
      required: ['text'],
    },
  },
  {
    name: 'browser_key',
    description: 'Press a key or shortcut as a real key press: "Enter", "Tab", "Escape", "ArrowDown", "Backspace", "PageDown", "Ctrl+A", "Shift+Tab". Optionally focus an element first by ref or selector. Use Enter to submit a search box.',
    localOk: false,
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        ref: REF,
        selector: { type: 'string' },
        tabId: TAB,
      },
      required: ['key'],
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page (or the scrolling panel in the middle of it) up/down/left/right, by default about one screen. Or pass a ref/selector to scroll that element into view.',
    localOk: false,
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['down', 'up', 'left', 'right'] },
        amount: { type: 'number', description: 'Pixels. Default ~80% of the screen.' },
        ref: REF,
        selector: { type: 'string' },
        tabId: TAB,
      },
    },
  },
  {
    name: 'browser_wait',
    description: 'Wait until a CSS selector or some text appears on the page, or -- with neither -- until the page has finished loading and network activity settles. Use after navigating or after a click that loads something.',
    authoritative: true,
    localOk: false,
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        text: { type: 'string' },
        timeoutMs: { type: 'number', description: 'Default 5000, max 15000.' },
        tabId: TAB,
      },
    },
  },
  {
    name: 'browser_read_text',
    description: 'Read the visible text content of Athena\'s working tab (or a specified tab).',
    authoritative: true, // measured fact about what's on the page right now, not opinion
    parameters: { type: 'object', properties: { tabId: { type: 'number' } } },
  },
  {
    name: 'browser_screenshot',
    description: 'Capture a screenshot of what is visible in Athena\'s working tab (or a specified tab). You receive the image itself; its pixel coordinates are what browser_click_at expects.',
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

// The actions that can fire a purchase. The approval gate (classifyRisk) only
// sees the call's selector/text, so it asks before {text:"Place order"} but
// not before {ref: 7} or {x, y} or {selector:"#btn-7"} that land on the same
// button. Unless the gate already saw purchase-like text -- meaning the user
// was asked, or AUTO_APPROVE_ALL said not to -- the extension gets the
// pattern and refuses to click anything whose real label matches it. Its
// refusal tells the model to name the label in `text`, which sends the retry
// through the gate.
const GUARDED = new Set(['browser_click', 'browser_click_at', 'browser_key']);

export function withPurchaseGuard(capability, args = {}) {
  if (!GUARDED.has(capability)) return args;
  const named = [args.selector, args.text].filter(Boolean).join(' ');
  if (PURCHASE_LIKE.test(named)) return args;
  return { ...args, guard: PURCHASE_LIKE.source };
}

// Relay deadlines: screenshots carry an image, and browser_wait is asked to
// take up to its own timeout -- give both room beyond the default 15s.
function relayTimeoutFor(capability, args) {
  if (capability === 'browser_screenshot') return 20_000;
  if (capability === 'browser_wait') return Math.min(Math.max(Number(args.timeoutMs) || 5000, 100), 15_000) + 8_000;
  return undefined;
}

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
    const { guard, ...clean } = args || {};   // only this module sets the guard, never the model
    const result = await submitCommand(capability, withPurchaseGuard(capability, clean), {
      timeoutMs: relayTimeoutFor(capability, clean),
    });
    return typeof result === 'string' ? result : JSON.stringify(result);
  },
};
