// extension/background.js -- Athena's link into the user's real Chrome.
//
// Talks directly to Athena's local relay (modules/browser/relay.mjs) over
// plain HTTP -- no native messaging, no OS-level registration, nothing
// outside this folder needs to exist on the host. Load this extension
// unpacked in any Chrome and it works immediately: that's the whole point.
// (Native messaging was tried and reverted -- it needs a per-machine
// registry entry pointing Chrome at a host executable, which is exactly
// the kind of host-side setup Athena is built to not depend on. A polling
// HTTP relay was always going to be the fit here, not a stepping stone to
// something else.)
//
// MV3 background service workers still get killed after ~30s of no
// activity, no matter the transport. chrome.alarms wakes this one back up
// on a fixed period; each wake opens a long-poll against the relay (which
// holds the request open up to ~25s waiting for a command instead of
// answering immediately), so delivery is close to instant whenever the
// worker happens to be alive, and self-heals on its own otherwise -- no
// separate "reconnect" step needed.
//
// Athena gets her own working tab, separate from whatever the user is
// actually looking at. athenaTabId below is that tab: browser_navigate
// with no explicit tabId reuses it (or opens a fresh, non-active one if it
// doesn't exist yet or was closed), and every other tab-targeting command
// falls back to it instead of Chrome's currently-active tab. Nothing here
// touches the user's own tabs unless a command hands over an explicit
// tabId.

const RELAY_BASE_URL = 'http://127.0.0.1:17861';
const POLL_ALARM_NAME = 'athena-relay-poll';
// 30s. Chrome only allows sub-1-minute repeating alarms for unpacked/dev-mode
// extensions -- a packed/store extension would need to raise this to 1
// (chrome.alarms clamps it there automatically anyway).
const POLL_PERIOD_MINUTES = 0.5;
const MAX_ROUNDS_PER_WAKE = 10; // keep long-polling back-to-back while awake, up to this many rounds

// Athena's own working tab. null until the first browser_navigate with no
// explicit tabId; cleared if the tab is closed (by the user or otherwise) so
// the next navigate opens a fresh one instead of erroring forever.
let athenaTabId = null;

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === athenaTabId) athenaTabId = null;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(POLL_ALARM_NAME, { periodInMinutes: POLL_PERIOD_MINUTES });
  drainQueue();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(POLL_ALARM_NAME, { periodInMinutes: POLL_PERIOD_MINUTES });
  drainQueue();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM_NAME) drainQueue();
});

let draining = false;
async function drainQueue() {
  if (draining) return; // an alarm fired mid-run -- the run already in flight covers it
  draining = true;
  try {
    for (let i = 0; i < MAX_ROUNDS_PER_WAKE; i++) {
      const command = await longPollOnce();
      if (!command) return; // relay's long-poll window elapsed with nothing queued -- back to sleep till the next alarm
      await runAndReport(command);
    }
  } finally {
    draining = false;
  }
}

async function longPollOnce() {
  try {
    const res = await fetch(`${RELAY_BASE_URL}/poll?wait=1`);
    if (!res.ok) return null;
    const { command } = await res.json();
    return command || null;
  } catch {
    // Athena isn't running, or the relay port changed -- nothing to do
    // until the next alarm; don't spam retries in a tight loop.
    return null;
  }
}

async function runAndReport(command) {
  const { id, action, args } = command;
  let ok = true, data = null, error = null;
  try {
    data = await runAction(action, args || {});
  } catch (err) {
    ok = false;
    error = (err && err.message) ? err.message : String(err);
  }
  try {
    await fetch(`${RELAY_BASE_URL}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ok, data, error }),
    });
  } catch {
    // The relay may have restarted mid-command -- the in-flight promise on
    // Athena's side will just time out; nothing more to do from here.
  }
}

// ---- Command dispatch ----------------------------------------------------

async function runAction(action, args) {
  switch (action) {
    case 'browser_navigate':   return navigate(args);
    case 'browser_click':      return click(args);
    case 'browser_type':       return typeText(args);
    case 'browser_read_text':  return readText(args);
    case 'browser_screenshot': return screenshot(args);
    case 'browser_list_tabs':  return listTabs();
    default: throw new Error(`unknown browser action "${action}"`);
  }
}

// Resolves which tab a command with no explicit tabId should act on:
// Athena's own working tab, never the user's currently-active one. Throws if
// there isn't one yet -- the caller needs to browser_navigate first (which
// creates it) or pass an explicit tabId.
async function resolveTabId(tabId) {
  if (typeof tabId === 'number') return tabId;
  if (athenaTabId !== null) {
    try {
      await chrome.tabs.get(athenaTabId); // throws if the tab's gone
      return athenaTabId;
    } catch {
      athenaTabId = null; // stale -- fall through to the error below
    }
  }
  throw new Error('no tab to target yet -- call browser_navigate first (or pass an explicit tabId)');
}

// One attach/detach per command -- simpler and safer than holding a debugger
// session open across a service worker that can be killed mid-flight. The
// visible "this extension is debugging this browser" infobar Chrome shows
// during CDP access is a Chrome limitation this cannot suppress.
async function withDebugger(tabId, fn) {
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try {
    return await fn(target);
  } finally {
    try { await chrome.debugger.detach(target); } catch { /* already detached */ }
  }
}

function sendCommand(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

// Explicit tabId -> operate on that tab and adopt it as Athena's working tab
// (so a follow-up command with no tabId continues on the same tab). No
// tabId, an existing working tab -> reuse it. Neither -> open a brand new,
// non-active tab, so navigating never steals the user's focus or touches
// whatever tab they're actually looking at.
async function navigate({ url, tabId }) {
  if (!url) throw new Error('browser_navigate needs a url');

  if (typeof tabId === 'number') {
    await chrome.tabs.update(tabId, { url });
    athenaTabId = tabId;
    return { navigated: url, tabId };
  }

  if (athenaTabId !== null) {
    try {
      await chrome.tabs.get(athenaTabId); // throws if it's been closed
      await chrome.tabs.update(athenaTabId, { url });
      return { navigated: url, tabId: athenaTabId };
    } catch {
      athenaTabId = null; // closed since last use -- open a fresh one below
    }
  }

  const tab = await chrome.tabs.create({ url, active: false });
  athenaTabId = tab.id;
  return { navigated: url, tabId: tab.id };
}

async function click({ selector, text, tabId }) {
  if (!selector && !text) throw new Error('browser_click needs a selector or text');
  const id = await resolveTabId(tabId);
  return withDebugger(id, async (target) => {
    await sendCommand(target, 'Runtime.enable');
    const expr = buildClickExpression({ selector, text });
    const { result, exceptionDetails } = await sendCommand(target, 'Runtime.evaluate', {
      expression: expr, returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text || 'click failed');
    if (!result?.value?.clicked) throw new Error(`no element matched ${selector ? `selector "${selector}"` : `text "${text}"`}`);
    return result.value;
  });
}

async function typeText({ selector, text, tabId }) {
  if (!text) throw new Error('browser_type needs text');
  const id = await resolveTabId(tabId);
  return withDebugger(id, async (target) => {
    await sendCommand(target, 'Runtime.enable');
    if (selector) {
      const focusExpr = buildFocusExpression(selector);
      const { result, exceptionDetails } = await sendCommand(target, 'Runtime.evaluate', {
        expression: focusExpr, returnByValue: true,
      });
      if (exceptionDetails) throw new Error(exceptionDetails.text || 'could not focus field');
      if (!result?.value?.focused) throw new Error(`no element matched selector "${selector}"`);
    }
    await sendCommand(target, 'Input.insertText', { text });
    return { typed: text.length };
  });
}

async function readText({ tabId }) {
  const id = await resolveTabId(tabId);
  return withDebugger(id, async (target) => {
    await sendCommand(target, 'Runtime.enable');
    const { result, exceptionDetails } = await sendCommand(target, 'Runtime.evaluate', {
      expression: '({ text: document.body ? document.body.innerText : "", title: document.title, url: location.href })',
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text || 'read failed');
    return result?.value ?? { text: '', title: '', url: '' };
  });
}

// CDP's Page.captureScreenshot instead of chrome.tabs.captureVisibleTab --
// captureVisibleTab can only ever capture whichever tab is the *active* tab
// of its window, which would break this the moment Athena's working tab
// isn't the one on screen (it's opened non-active, on purpose, so as not to
// steal the user's focus). Page.captureScreenshot works over the same
// debugger session already used for click/type/read, active or not.
async function screenshot({ tabId }) {
  const id = await resolveTabId(tabId);
  return withDebugger(id, async (target) => {
    await sendCommand(target, 'Page.enable');
    const { data } = await sendCommand(target, 'Page.captureScreenshot', { format: 'png' });
    return { dataUrl: `data:image/png;base64,${data}` };
  });
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active }));
}

// ---- Small in-page expressions run via Runtime.evaluate -------------------
// Kept as plain strings (not chrome.scripting.executeScript) because the
// debugger session is already attached for every other CDP call this file
// makes, and staying on one channel per command keeps the attach/detach
// lifecycle simple.

function buildClickExpression({ selector, text }) {
  const sel = JSON.stringify(selector || '');
  const txt = JSON.stringify(text || '');
  return `(() => {
    let el = null;
    const selector = ${sel};
    const text = ${txt};
    if (selector) el = document.querySelector(selector);
    if (!el && text) {
      const all = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="submit"], input[type="button"]'));
      el = all.find(e => (e.innerText || e.value || '').trim().includes(text));
    }
    if (!el) return { clicked: false };
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { clicked: true };
  })()`;
}

function buildFocusExpression(selector) {
  const sel = JSON.stringify(selector);
  return `(() => {
    const el = document.querySelector(${sel});
    if (!el) return { focused: false };
    el.focus();
    return { focused: true };
  })()`;
}
