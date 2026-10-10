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
// separate "reconnect" step needed. While Athena is running the poll loop
// keeps the worker alive (see drainQueue).
//
// Athena gets her own working tab, separate from whatever the user is
// actually looking at, in a window of its own opened without focus.
// athenaTabId below is that tab: browser_navigate with no explicit tabId
// reuses it (or opens a fresh window if it doesn't exist yet or was
// closed), and every other tab-targeting command falls back to it instead of
// Chrome's currently-active tab. Nothing here touches the user's own tabs
// unless a command hands over an explicit tabId.
//
// Why a window and not a background tab: Chrome barely services a tab that
// is not on screen. Measured in Chromium 140 -- trusted clicks into a
// background tab took 5s each and about half never landed until much
// later, and half the screenshots stalled waiting for a frame. As the
// active tab of its own window the same clicks land in ~15ms. The window is
// still "not on screen" if it is minimized, or (on Windows/macOS) fully
// covered by other windows, so slow input is detected and reported below
// rather than assumed to have worked.
//
// Input is real: clicks and key presses go through CDP's Input domain
// (Input.dispatchMouseEvent / Input.dispatchKeyEvent), so the page sees
// trusted events -- the same thing a person's mouse produces. The old
// el.click() fired isTrusted:false events that many sites quietly ignore.
// Page-side lookups (finding an element, reading its label, the snapshot)
// run in an isolated world: the page shares the DOM with it but not its
// JavaScript, so a page cannot patch the functions this code relies on --
// in particular the purchase guard below.

const RELAY_BASE_URL = 'http://127.0.0.1:17861';
const POLL_ALARM_NAME = 'athena-relay-poll';
// 30s. Chrome only allows sub-1-minute repeating alarms for unpacked/dev-mode
// extensions -- a packed/store extension would need to raise this to 1
// (chrome.alarms clamps it there automatically anyway).
const POLL_PERIOD_MINUTES = 0.5;

// Athena's own working tab. null until the first browser_navigate with no
// explicit tabId; cleared if the tab is closed (by the user or otherwise) so
// the next navigate opens a fresh one instead of erroring forever.
// Mirrored into chrome.storage.session so a service worker restart (MV3
// kills idle workers) does not forget it and open yet another window.
let athenaTabId = null;

async function loadAthenaTab() {
  if (athenaTabId === null) {
    try {
      const v = await chrome.storage.session.get('athenaTabId');
      if (typeof v.athenaTabId === 'number') athenaTabId = v.athenaTabId;
    } catch { /* storage unavailable -- memory only */ }
  }
  return athenaTabId;
}

function setAthenaTab(id) {
  athenaTabId = id;
  chrome.storage.session.set({ athenaTabId: id }).catch(() => {});
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === await loadAthenaTab()) setAthenaTab(null);
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

// Keeps long-polling for as long as the relay answers. It used to stop after
// 10 commands and sleep until the next alarm -- fine for one-off actions, but
// a snapshot -> click -> wait -> snapshot loop hits 10 in seconds and then
// stalls for up to 30s. A pending fetch does not count as activity for MV3's
// idle timer, so each round also makes a trivial extension API call, which
// does. When Athena is not running the poll fails and the loop ends; the
// alarm picks it back up later.
let draining = false;
async function drainQueue() {
  if (draining) return; // an alarm fired mid-run -- the run already in flight covers it
  draining = true;
  try {
    for (;;) {
      chrome.runtime.getPlatformInfo(() => {}); // resets the service worker idle timer
      const asked = Date.now();
      const { alive, command } = await longPollOnce();
      if (!alive) return; // relay unreachable -- back to sleep till the next alarm
      if (command) await runAndReport(command);
      else if (Date.now() - asked < 1000) await sleep(1000); // an empty answer should have been held open -- never spin
    }
  } finally {
    draining = false;
  }
}

async function longPollOnce() {
  try {
    const res = await fetch(`${RELAY_BASE_URL}/poll?wait=1`);
    if (!res.ok) return { alive: false };
    const { command } = await res.json();
    return { alive: true, command: command || null };
  } catch {
    // Athena isn't running, or the relay port changed -- nothing to do
    // until the next alarm; don't spam retries in a tight loop.
    return { alive: false };
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
    case 'browser_snapshot':   return snapshot(args);
    case 'browser_click':      return click(args);
    case 'browser_click_at':   return clickAt(args);
    case 'browser_type':       return typeText(args);
    case 'browser_key':        return pressKey(args);
    case 'browser_scroll':     return scroll(args);
    case 'browser_wait':       return waitFor(args);
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
  if (await loadAthenaTab() !== null) {
    try {
      await chrome.tabs.get(athenaTabId); // throws if the tab's gone
      return athenaTabId;
    } catch {
      setAthenaTab(null); // stale -- fall through to the error below
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Runs `body` (the inside of an async function) in a fresh isolated world on
// the tab's main frame, with PAGE_LIB in scope and the command's args bound to
// ARGS. A returned { error } becomes a thrown Error so every caller reports
// page-side failures the same way.
async function pageEval(target, body, args = {}) {
  const { frameTree } = await sendCommand(target, 'Page.getFrameTree');
  const { executionContextId } = await sendCommand(target, 'Page.createIsolatedWorld', {
    frameId: frameTree.frame.id, worldName: 'athena',
  });
  const expression = '(async () => {\n' + PAGE_LIB + '\nconst ARGS = ' + JSON.stringify(args) + ';\n' + body + '\n})()';
  const { result, exceptionDetails } = await sendCommand(target, 'Runtime.evaluate', {
    expression, contextId: executionContextId, returnByValue: true, awaitPromise: true,
  });
  if (exceptionDetails) {
    const desc = exceptionDetails.exception && exceptionDetails.exception.description;
    throw new Error((desc ? desc.split('\n')[0] : exceptionDetails.text) || 'page script failed');
  }
  const value = result ? result.value : undefined;
  if (value && value.error) throw new Error(value.error);
  return value;
}

// A trusted left click at CSS-pixel viewport coordinates: move, press,
// release -- the move first so hover handlers and menus see the pointer.
// Returns a warning when Chrome was slow to take the input: that is what a
// tab that is not on screen looks like (see the header), and the event may
// then land seconds later. Retrying would risk a double click, so the model
// is told to check instead.
async function mouseClick(target, x, y) {
  const started = Date.now();
  await sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  return slowInputWarning(started, 'click');
}

const SLOW_INPUT_MS = 1500;
function slowInputWarning(started, what) {
  if (Date.now() - started < SLOW_INPUT_MS) return undefined;
  return `Chrome was slow to deliver this ${what} -- the tab is probably not on screen (minimized or covered). ` +
    'It may land late: check with browser_snapshot before repeating it, and ask the user to keep Athena\'s window visible.';
}

// ---- Purchase guard -------------------------------------------------------
// Athena's approval gate (classifyRisk in tools.mjs) asks before a click whose
// selector/text looks like a purchase. A click by snapshot ref, by
// coordinates, or by a selector like "#btn-7" carries no such text, so the
// gate cannot see it. modules/browser.mjs therefore sends the pattern along as
// args.guard whenever the gate did not already ask, and this file refuses to
// click an element whose real label matches it. Naming the label in `text`
// and calling again routes the click through the approval prompt.

function guardHits(guard, label) {
  if (!guard || !label) return false;
  try { return new RegExp(guard, 'i').test(label); } catch { return true; } // a broken pattern must fail closed
}

function guardRefusal(label, retry) {
  return `refused: "${label}" looks like a purchase/checkout control. ${retry} so the user is asked to approve it first.`;
}

// ---- Actions --------------------------------------------------------------

// Explicit tabId -> operate on that tab and adopt it as Athena's working tab
// (so a follow-up command with no tabId continues on the same tab). No
// tabId, an existing working tab -> reuse it. Neither -> open a new window
// without focus, so navigating never steals the user's focus or touches
// whatever tab they're actually looking at (see the header for why a window).
async function navigate({ url, tabId }) {
  if (!url) throw new Error('browser_navigate needs a url');

  if (typeof tabId === 'number') {
    await chrome.tabs.update(tabId, { url });
    setAthenaTab(tabId);
    return { navigated: url, tabId };
  }

  if (await loadAthenaTab() !== null) {
    try {
      await chrome.tabs.get(athenaTabId); // throws if it's been closed
      await chrome.tabs.update(athenaTabId, { url });
      return { navigated: url, tabId: athenaTabId };
    } catch {
      setAthenaTab(null); // closed since last use -- open a fresh one below
    }
  }

  const win = await chrome.windows.create({ url, focused: false, width: 1280, height: 860 });
  const tab = win.tabs[0];
  setAthenaTab(tab.id);
  return { navigated: url, tabId: tab.id, window: 'opened Athena\'s own window (unfocused) -- keep it visible, not minimized, for reliable clicks' };
}

// Numbers every visible interactive element ([12] button "Send") and tags it
// in the DOM so browser_click / browser_type can target it by ref. Refs hold
// until the next snapshot or until the page changes underneath them.
async function snapshot({ tabId, viewportOnly }) {
  const id = await resolveTabId(tabId);
  return withDebugger(id, (target) => pageEval(target, SNAPSHOT_BODY, { viewportOnly: !!viewportOnly }));
}

async function click(args) {
  const { ref, selector, text, guard, tabId } = args;
  if (ref == null && !selector && !text) throw new Error('browser_click needs a ref, selector or text');
  const id = await resolveTabId(tabId);
  return withDebugger(id, async (target) => {
    const t = await pageEval(target, PREPARE_CLICK_BODY, { ref, selector, text });
    if (guardHits(guard, t.label)) {
      throw new Error(guardRefusal(t.label, `To click it, call browser_click again with text: "${t.label}"`));
    }
    if (t.zeroSize) {
      // Nothing on screen to aim at (a hidden file input, a visually-hidden
      // checkbox) -- a synthetic click is the only way to reach it.
      await pageEval(target, 'const f = findTarget(ARGS); if (f.error) return f; f.el.click(); return {};', { ref, selector, text });
      return { clicked: t.label, role: t.role, method: 'synthetic (element has no size on screen)' };
    }
    if (t.coveredBy) {
      throw new Error(`"${t.label}" is covered by ${t.coveredBy} at that spot -- a click would hit that instead. ` +
        'Close the overlay (cookie banner, dialog) first, or click the covering element if it is part of the same control.');
    }
    const warning = await mouseClick(target, t.x, t.y);
    return { clicked: t.label, role: t.role, method: 'trusted', at: { x: Math.round(t.x), y: Math.round(t.y) }, warning };
  });
}

// Coordinates are in browser_screenshot's image pixels; the page side
// converts them back to CSS pixels using the same scale the screenshot used.
async function clickAt({ x, y, text, guard, tabId }) {
  if (typeof x !== 'number' || typeof y !== 'number') throw new Error('browser_click_at needs numeric x and y');
  const id = await resolveTabId(tabId);
  return withDebugger(id, async (target) => {
    const t = await pageEval(target, PREPARE_CLICK_AT_BODY, { x, y, text });
    if (guardHits(guard, t.label)) {
      throw new Error(guardRefusal(t.label, `To click it, call browser_click_at again with the same x and y and text: "${t.label}"`));
    }
    const warning = await mouseClick(target, t.x, t.y);
    return { clicked: t.label || '(no label)', role: t.role, method: 'trusted', at: { x: Math.round(t.x), y: Math.round(t.y) }, warning };
  });
}

async function typeText({ ref, selector, text, clear, tabId }) {
  if (typeof text !== 'string' || (!text && !clear)) throw new Error('browser_type needs text (or clear: true)');
  const id = await resolveTabId(tabId);
  return withDebugger(id, async (target) => {
    let field = null;
    if (ref != null || selector) field = await pageEval(target, FOCUS_BODY, { ref, selector, clear: !!clear });
    else if (clear) await pageEval(target, FOCUS_BODY, { focused: true, clear: true });
    if (text) await sendCommand(target, 'Input.insertText', { text });
    else await dispatchKey(target, parseKey('Backspace'));   // clear with nothing to type: delete the selection
    return { typed: text.length, cleared: !!clear, field: field ? field.label : undefined };
  });
}

async function pressKey({ key, modifiers, ref, selector, guard, tabId }) {
  if (!key) throw new Error('browser_key needs a key, e.g. "Enter", "Tab", "Escape", "ArrowDown" or "Ctrl+A"');
  const k = parseKey(key, modifiers);
  const id = await resolveTabId(tabId);
  return withDebugger(id, async (target) => {
    if (ref != null || selector) await pageEval(target, FOCUS_BODY, { ref, selector });
    if (k.key === 'Enter' && guard) {
      // Enter in a form fires its submit button -- the same purchase a click would make.
      const f = await pageEval(target, ENTER_SUBMITS_BODY, {});
      if (f && guardHits(guard, f.label)) {
        throw new Error(guardRefusal(f.label, `Enter would submit this form through it. Use browser_click with text: "${f.label}" instead`));
      }
    }
    const started = Date.now();
    await dispatchKey(target, k);
    return { pressed: key, warning: slowInputWarning(started, 'key press') };
  });
}

// Programmatic scrolling rather than a synthetic wheel: it is deterministic,
// works on a tab that is not on screen, and still fires the page's scroll
// events (infinite feeds load the same way).
async function scroll({ direction = 'down', amount, ref, selector, tabId }) {
  const id = await resolveTabId(tabId);
  return withDebugger(id, (target) => pageEval(target, SCROLL_BODY, { direction, amount, ref, selector }));
}

// Waits for a selector or text to show up, or -- with neither -- for the page
// to finish loading and the network to go (nearly) quiet. A navigation in the
// middle destroys the isolated world; that is retried until the deadline.
async function waitFor({ selector, text, timeoutMs, tabId }) {
  const limit = Math.min(Math.max(Number(timeoutMs) || 5000, 100), 15000);
  const deadline = Date.now() + limit;
  const id = await resolveTabId(tabId);
  return withDebugger(id, async (target) => {
    const started = Date.now();
    for (;;) {
      try {
        await pageEval(target, WAIT_BODY, { selector, text, untilMs: deadline - Date.now() });
        break;
      } catch (err) {
        const msg = String(err && err.message);
        if (Date.now() < deadline && /context|navigat|frame|detached/i.test(msg)) { await sleep(200); continue; }
        throw err;
      }
    }
    if (selector || text) return { found: selector || text, waitedMs: Date.now() - started };
    const settled = await networkQuiet(target, 500, deadline);
    return settled
      ? { settled: true, waitedMs: Date.now() - started }
      : { settled: false, waitedMs: Date.now() - started, note: 'page loaded but network never went quiet (live connections or polling) -- usually fine to continue' };
  });
}

// "Quiet" is at most two requests in flight for quietMs -- the same idea as
// Puppeteer's networkidle2, so a page holding one long-poll open still settles.
async function networkQuiet(target, quietMs, deadline) {
  const inflight = new Set();
  let lastActivity = Date.now();
  const onEvent = (source, method, params) => {
    if (source.tabId !== target.tabId) return;
    if (method === 'Network.requestWillBeSent') { inflight.add(params.requestId); lastActivity = Date.now(); }
    else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') { inflight.delete(params.requestId); lastActivity = Date.now(); }
  };
  chrome.debugger.onEvent.addListener(onEvent);
  try {
    await sendCommand(target, 'Network.enable');
    while (Date.now() < deadline) {
      if (inflight.size <= 2 && Date.now() - lastActivity >= quietMs) return true;
      await sleep(100);
    }
    return false;
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
  }
}

async function readText({ tabId }) {
  const id = await resolveTabId(tabId);
  return withDebugger(id, (target) => pageEval(target,
    'return { text: document.body ? document.body.innerText : "", title: document.title, url: location.href };'));
}

// CDP's Page.captureScreenshot instead of chrome.tabs.captureVisibleTab --
// captureVisibleTab can only ever capture whichever tab is the *active* tab
// of its window, which would break this the moment Athena's working tab
// isn't the one on screen (it's opened non-active, on purpose, so as not to
// steal the user's focus). Page.captureScreenshot works over the same
// debugger session already used for click/type/read, active or not.
//
// The image is scaled to SHOT_SCALE(viewport) image pixels per CSS pixel --
// device pixel ratio removed, long edge capped at MAX_SHOT_EDGE -- so a
// high-DPI screen does not produce a picture the model API would silently
// shrink, and so browser_click_at can map the model's coordinates back exactly.
async function screenshot({ tabId }) {
  const id = await resolveTabId(tabId);
  return withDebugger(id, async (target) => {
    const vp = await pageEval(target, 'return viewportInfo();');
    const { data } = await captureWithRetry(target, {
      format: 'png',
      // clip is in document coordinates, so the visible part starts at the scroll offset
      // and Chrome multiplies clip.scale by the device pixel ratio itself (measured), so divide it out
      clip: { x: vp.scrollX, y: vp.scrollY, width: vp.cssWidth, height: vp.cssHeight, scale: vp.scale / vp.dpr },
    });
    return {
      dataUrl: `data:image/png;base64,${data}`,
      width: Math.round(vp.cssWidth * vp.scale),
      height: Math.round(vp.cssHeight * vp.scale),
      scale: Number(vp.scale.toFixed(4)), // image pixels per CSS pixel
      url: vp.url, title: vp.title,
    };
  });
}

// A tab that is not on screen only renders when something asks it to, and
// about half of the captures there wait for a frame that never arrives.
// Measured in Chromium, headless and headed alike: the attempt right after a
// stalled one returns a correct, current image. So each attempt gets a short
// deadline, and a stalled one is simply asked again.
async function captureWithRetry(target, params) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const pending = sendCommand(target, 'Page.captureScreenshot', params);
    pending.catch(() => {}); // an abandoned attempt rejects on detach -- not an error worth reporting
    const result = await Promise.race([pending, sleep(2500).then(() => null)]);
    if (result) return result;
  }
  throw new Error('the tab did not render a frame to capture (it is not on screen) -- try again, or use browser_snapshot');
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active }));
}

// ---- Keys -----------------------------------------------------------------

const NAMED_KEYS = {
  enter:     { key: 'Enter',      code: 'Enter',      keyCode: 13, text: '\r' },
  return:    { key: 'Enter',      code: 'Enter',      keyCode: 13, text: '\r' },
  tab:       { key: 'Tab',        code: 'Tab',        keyCode: 9 },
  escape:    { key: 'Escape',     code: 'Escape',     keyCode: 27 },
  esc:       { key: 'Escape',     code: 'Escape',     keyCode: 27 },
  backspace: { key: 'Backspace',  code: 'Backspace',  keyCode: 8 },
  delete:    { key: 'Delete',     code: 'Delete',     keyCode: 46 },
  del:       { key: 'Delete',     code: 'Delete',     keyCode: 46 },
  space:     { key: ' ',          code: 'Space',      keyCode: 32, text: ' ' },
  arrowup:   { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 },
  arrowdown: { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40 },
  arrowleft: { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 },
  arrowright:{ key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  up:        { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 },
  down:      { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40 },
  left:      { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 },
  right:     { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home:      { key: 'Home',       code: 'Home',       keyCode: 36 },
  end:       { key: 'End',        code: 'End',        keyCode: 35 },
  pageup:    { key: 'PageUp',     code: 'PageUp',     keyCode: 33 },
  pagedown:  { key: 'PageDown',   code: 'PageDown',   keyCode: 34 },
};
const MODIFIER_BITS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

// "Enter", "ctrl+a", "Shift+Tab", or a key plus a modifiers array.
function parseKey(spec, extraModifiers = []) {
  const parts = String(spec).split('+').map(p => p.trim()).filter(Boolean);
  if (String(spec).endsWith('++')) parts.push('+');
  let name = parts.pop() || '';
  let modifiers = 0;
  for (const m of [...parts, ...(Array.isArray(extraModifiers) ? extraModifiers : [])]) {
    const bit = MODIFIER_BITS[String(m).toLowerCase()];
    if (!bit) throw new Error(`unknown modifier "${m}" (use ctrl, shift, alt or meta)`);
    modifiers |= bit;
  }
  let k = NAMED_KEYS[name.toLowerCase()];
  if (!k && /^f([1-9]|1[0-2])$/i.test(name)) {
    const n = Number(name.slice(1));
    k = { key: 'F' + n, code: 'F' + n, keyCode: 111 + n };
  }
  if (!k && name.length === 1) {
    const ch = (modifiers & 8) ? name.toUpperCase() : name;
    const up = name.toUpperCase();
    const code = /[A-Z]/.test(up) ? 'Key' + up : /[0-9]/.test(name) ? 'Digit' + name : '';
    k = { key: ch, code, keyCode: up.charCodeAt(0), text: ch };
  }
  if (!k) throw new Error(`unknown key "${name}"`);
  // With ctrl/alt/meta held it is a shortcut, not typing -- no text.
  const text = (modifiers & 7) ? undefined : k.text;
  return { ...k, text, modifiers };
}

async function dispatchKey(target, k) {
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: k.modifiers || 0 };
  await sendCommand(target, 'Input.dispatchKeyEvent', k.text
    ? { ...base, type: 'keyDown', text: k.text, unmodifiedText: k.text }
    : { ...base, type: 'rawKeyDown' });
  await sendCommand(target, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

// ---- Page-side code (runs in the isolated world via pageEval) -------------
// Plain strings, no template literals inside, so nothing in them is
// interpolated by accident. ARGS is bound by pageEval.

const PAGE_LIB = String.raw`
const REF_ATTR = 'data-athena-ref';
const MAX_SHOT_EDGE = 1280;
const INTERACTIVE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, ' +
  '[role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], ' +
  '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="combobox"], ' +
  '[role="textbox"], [role="searchbox"], [role="slider"], [role="spinbutton"], ' +
  '[contenteditable=""], [contenteditable="true"], [onclick], [tabindex]:not([tabindex="-1"])';

// querySelectorAll that also looks inside open shadow roots.
function deepAll(selector, root) {
  const out = [];
  const walk = (node) => {
    for (const el of node.querySelectorAll(selector)) out.push(el);
    for (const el of node.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
  };
  walk(root || document);
  return out;
}

// elementFromPoint that descends into open shadow roots.
function deepHit(x, y) {
  let h = document.elementFromPoint(x, y);
  while (h && h.shadowRoot) {
    const inner = h.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === h) break;
    h = inner;
  }
  return h;
}

function clean(s, n) {
  n = n || 80;
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 3) + '...' : s;
}

function isVisible(el) {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const cs = getComputedStyle(el);
  if (cs.visibility === 'hidden' || cs.display === 'none') return false;
  if (el.closest('[aria-hidden="true"], [inert]')) return false;
  return true;
}

function labelOf(el) {
  if (!el || el.nodeType !== 1) return '';
  const aria = el.getAttribute('aria-label');
  if (aria && clean(aria)) return clean(aria);
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const t = clean(by.split(/\s+/).map(i => { const n = document.getElementById(i); return n ? n.innerText : ''; }).join(' '));
    if (t) return t;
  }
  const tag = el.tagName;
  if (tag === 'INPUT') {
    const type = (el.type || '').toLowerCase();
    if (type === 'submit' || type === 'button' || type === 'reset') return clean(el.value || type);
    if (type === 'image') return clean(el.alt || el.title || 'image button');
  }
  if (el.labels && el.labels.length) {
    const t = clean(Array.from(el.labels).map(l => l.innerText).join(' '));
    if (t) return t;
  }
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return clean(el.placeholder || el.title || el.getAttribute('name') || '');
  }
  const text = clean(el.innerText || el.textContent);
  if (text) return text;
  const img = el.querySelector('img[alt]');
  if (img && clean(img.alt)) return clean(img.alt);
  return clean(el.title || el.getAttribute('name') || '');
}

function roleOf(el) {
  if (!el || el.nodeType !== 1) return '';
  const r = el.getAttribute('role');
  if (r) return r;
  const tag = el.tagName.toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'button' || tag === 'summary') return 'button';
  if (tag === 'select') return 'select';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    const t = (el.type || 'text').toLowerCase();
    if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
    if (t === 'text') return 'textbox';
    return t;
  }
  if (el.isContentEditable) return 'textbox';
  return tag;
}

function stateOf(el) {
  const bits = [];
  const tag = el.tagName;
  const type = (el.type || '').toLowerCase();
  if (tag === 'INPUT' && (type === 'checkbox' || type === 'radio')) bits.push(el.checked ? 'checked' : 'unchecked');
  else if (tag === 'INPUT' && type === 'password') { if (el.value) bits.push('value=<hidden>'); }
  else if ((tag === 'INPUT' || tag === 'TEXTAREA') && !/^(submit|button|reset|image|file)$/.test(type) && el.value) bits.push('value="' + clean(el.value, 40) + '"');
  else if (tag === 'SELECT' && el.selectedOptions && el.selectedOptions[0]) bits.push('selected="' + clean(el.selectedOptions[0].text, 40) + '"');
  const ac = el.getAttribute('aria-checked');
  if (ac && tag !== 'INPUT') bits.push(ac === 'true' ? 'checked' : 'unchecked');
  const ax = el.getAttribute('aria-expanded');
  if (ax) bits.push(ax === 'true' ? 'expanded' : 'collapsed');
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') bits.push('disabled');
  if (tag === 'A') {
    const h = el.getAttribute('href');
    if (h && !/^javascript:/i.test(h) && h !== '#') bits.push('-> ' + clean(h, 60));
  }
  return bits.join(' ');
}

function findTarget(a) {
  if (a.ref !== undefined && a.ref !== null && a.ref !== '') {
    const n = String(a.ref).replace(/[^0-9]/g, '');
    const hits = n ? deepAll('[' + REF_ATTR + '="' + n + '"]') : [];
    if (hits.length !== 1) return { error: 'ref ' + a.ref + ' is no longer on the page (it changed or navigated) -- call browser_snapshot again' };
    return { el: hits[0] };
  }
  if (a.selector) {
    let all;
    try { all = deepAll(a.selector); } catch (e) { return { error: 'invalid CSS selector "' + a.selector + '"' }; }
    const el = all.find(isVisible) || all[0];
    if (el) return { el: el };
    if (!a.text) return { error: 'no element matched selector "' + a.selector + '"' };
  }
  if (a.text) {
    const want = clean(a.text).toLowerCase();
    const cands = deepAll(INTERACTIVE).filter(isVisible);
    const el = cands.find(e => labelOf(e).toLowerCase() === want) || cands.find(e => labelOf(e).toLowerCase().includes(want));
    if (el) return { el: el };
    return { error: 'no clickable element matched text "' + a.text + '" -- call browser_snapshot to see what is there' };
  }
  return { error: 'needs a ref, selector or text' };
}

// Image pixels per CSS pixel in browser_screenshot: device pixel ratio
// removed, long edge capped at MAX_SHOT_EDGE.
function viewportInfo() {
  const cssWidth = document.documentElement.clientWidth || innerWidth;
  const cssHeight = document.documentElement.clientHeight || innerHeight;
  const scale = Math.min(1, MAX_SHOT_EDGE / Math.max(cssWidth, cssHeight));
  return { cssWidth: cssWidth, cssHeight: cssHeight, scale: scale, dpr: devicePixelRatio || 1, scrollX: scrollX, scrollY: scrollY, url: location.href, title: document.title };
}
`;

const SNAPSHOT_BODY = String.raw`
const MAX = 250;
for (const old of deepAll('[' + REF_ATTR + ']')) old.removeAttribute(REF_ATTR);
const seen = new Set();
const lines = [];
let n = 0, truncated = false, skippedOffscreen = 0;
for (const el of deepAll(INTERACTIVE)) {
  if (seen.has(el)) continue;
  seen.add(el);
  if (!isVisible(el)) continue;
  const r = el.getBoundingClientRect();
  const off = r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth;
  if (off && ARGS.viewportOnly) { skippedOffscreen++; continue; }
  if (n >= MAX) { truncated = true; break; }
  n++;
  el.setAttribute(REF_ATTR, String(n));
  const state = stateOf(el);
  lines.push('[' + n + '] ' + roleOf(el) + ' "' + labelOf(el) + '"' + (state ? ' ' + state : '') + (off ? ' (offscreen)' : ''));
}
return {
  url: location.href,
  title: document.title,
  scroll: { y: Math.round(scrollY), pageHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight },
  count: n,
  truncated: truncated,
  skippedOffscreen: skippedOffscreen || undefined,
  elements: lines.join('\n'),
};
`;

// Finds the element, scrolls it to the middle of the viewport, and works out
// where a real click should land -- the centre of its visible part -- plus
// whether something else is on top at that spot.
const PREPARE_CLICK_BODY = String.raw`
const f = findTarget(ARGS);
if (f.error) return f;
const el = f.el;
const label = labelOf(el), role = roleOf(el);
if (ARGS.ref != null && ARGS.text && !label.toLowerCase().includes(clean(ARGS.text).toLowerCase())) {
  return { error: 'ref ' + ARGS.ref + ' is "' + label + '", not "' + ARGS.text + '" -- call browser_snapshot again' };
}
el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
const r = el.getBoundingClientRect();
if (r.width < 1 || r.height < 1) return { label: label, role: role, zeroSize: true };
const left = Math.max(r.left, 0), right = Math.min(r.right, innerWidth);
const top = Math.max(r.top, 0), bottom = Math.min(r.bottom, innerHeight);
if (right <= left || bottom <= top) return { label: label, role: role, zeroSize: true };
const x = (left + right) / 2, y = (top + bottom) / 2;
const hit = deepHit(x, y);
const ok = !hit || hit === el || el.contains(hit) || hit.contains(el) ||
  (el.labels && Array.from(el.labels).some(l => l.contains(hit)));
if (!ok) {
  const cover = hit.closest(INTERACTIVE) || hit;
  return { label: label, role: role, x: x, y: y, coveredBy: roleOf(cover) + ' "' + labelOf(cover) + '"' };
}
return { label: label, role: role, x: x, y: y };
`;

const PREPARE_CLICK_AT_BODY = String.raw`
const s = viewportInfo().scale;
const x = ARGS.x / s, y = ARGS.y / s;
if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) {
  return { error: 'x/y is outside the page -- coordinates are pixels in the latest browser_screenshot image' };
}
const hit = deepHit(x, y);
const el = hit ? (hit.closest(INTERACTIVE) || hit) : null;
const label = labelOf(el), role = roleOf(el);
if (ARGS.text && !label.toLowerCase().includes(clean(ARGS.text).toLowerCase())) {
  return { error: 'the element at that spot is "' + label + '", not "' + ARGS.text + '" -- take a new browser_screenshot' };
}
return { label: label, role: role, x: x, y: y };
`;

const FOCUS_BODY = String.raw`
let el;
if (ARGS.focused) {
  el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (!el || el === document.body) return { error: 'nothing is focused -- pass a ref or selector for the field' };
} else {
  const f = findTarget(ARGS);
  if (f.error) return f;
  el = f.el;
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  el.focus();
}
if (ARGS.clear) {
  if (typeof el.select === 'function') el.select();
  else if (el.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
}
return { label: labelOf(el), role: roleOf(el) };
`;

// The button an Enter key press in the focused field would trigger, if any.
const ENTER_SUBMITS_BODY = String.raw`
let el = document.activeElement;
while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
if (!el) return null;
const form = el.form || (el.closest && el.closest('form'));
if (!form) return null;
const btn = form.querySelector('button[type="submit"], button:not([type]), input[type="submit"], input[type="image"]');
return btn ? { label: labelOf(btn) } : null;
`;

const SCROLL_BODY = String.raw`
if (ARGS.ref != null || ARGS.selector) {
  const f = findTarget(ARGS);
  if (f.error) return f;
  f.el.scrollIntoView({ block: 'center', behavior: 'instant' });
  return { scrolledTo: labelOf(f.el), y: Math.round(scrollY) };
}
const dir = String(ARGS.direction || 'down').toLowerCase();
const vertical = dir === 'down' || dir === 'up';
const dist = Number(ARGS.amount) || Math.round((vertical ? innerHeight : innerWidth) * 0.8);
const sign = (dir === 'up' || dir === 'left') ? -1 : 1;
// Scroll whatever is under the middle of the viewport if it scrolls (a feed
// in a panel), otherwise the page itself.
let box = deepHit(innerWidth / 2, innerHeight / 2);
while (box && box !== document.body && box !== document.documentElement) {
  const cs = getComputedStyle(box);
  const can = vertical
    ? /(auto|scroll)/.test(cs.overflowY) && box.scrollHeight > box.clientHeight
    : /(auto|scroll)/.test(cs.overflowX) && box.scrollWidth > box.clientWidth;
  if (can) break;
  box = box.parentElement;
}
const scroller = (box && box !== document.body && box !== document.documentElement) ? box : (document.scrollingElement || document.documentElement);
const before = vertical ? scroller.scrollTop : scroller.scrollLeft;
scroller.scrollBy({ top: vertical ? sign * dist : 0, left: vertical ? 0 : sign * dist, behavior: 'instant' });
await new Promise(r => setTimeout(r, 150));
const after = vertical ? scroller.scrollTop : scroller.scrollLeft;
const max = vertical ? scroller.scrollHeight - scroller.clientHeight : scroller.scrollWidth - scroller.clientWidth;
return {
  moved: Math.round(after - before),
  position: Math.round(after),
  max: Math.round(max),
  atEnd: sign > 0 ? after >= max - 2 : after <= 2,
  container: scroller === (document.scrollingElement || document.documentElement) ? 'page' : roleOf(scroller) + ' "' + labelOf(scroller).slice(0, 40) + '"',
};
`;

const WAIT_BODY = String.raw`
const until = Date.now() + Math.max(0, ARGS.untilMs || 0);
const want = ARGS.text ? clean(ARGS.text).toLowerCase() : '';
const ready = () => {
  if (ARGS.selector) {
    try { return deepAll(ARGS.selector).some(isVisible); } catch (e) { return 'bad'; }
  }
  if (want) return !!document.body && clean(document.body.innerText, 1e9).toLowerCase().includes(want);
  return document.readyState === 'complete';
};
for (;;) {
  const r = ready();
  if (r === 'bad') return { error: 'invalid CSS selector "' + ARGS.selector + '"' };
  if (r) return { ok: true };
  if (Date.now() >= until) {
    return { error: 'timed out waiting for ' + (ARGS.selector ? 'selector "' + ARGS.selector + '"' : want ? 'text "' + ARGS.text + '"' : 'the page to finish loading') };
  }
  await new Promise(res => setTimeout(res, 150));
}
`;
