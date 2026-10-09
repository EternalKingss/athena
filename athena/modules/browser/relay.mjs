// modules/browser/relay.mjs -- Module 2's link to the real Chrome.
//
// Athena talks to the user's actual, already-signed-in Chrome through a
// small Manifest V3 extension (see extension/), not a spun-off automation
// profile. The extension reaches this relay via Chrome's Native Messaging
// API (native_host.mjs is the bridge Chrome spawns) -- this file has no idea
// whether a native-messaging bridge or a plain HTTP poller is on the other
// end, and doesn't need to: its only job is holding a queue of commands and
// matching each one's eventual result back to the promise that's waiting on
// it, over plain node:http (no npm dependency, and matches the "she carries
// whatever she needs on her own drive" rule better than depending on any
// particular transport library being present).
//
// This file is Module 2's only server-side surface. It does not import
// anything from modules/system.mjs or tools.mjs, and nothing in Module 1
// imports this file -- isolation is enforced by construction, not by
// convention.

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 15_000;
const EXTENSION_STALE_MS = 45_000; // no poll in this long = treat the extension as gone
const LONG_POLL_MAX_MS = 25_000;   // how long a ?wait=1 /poll holds open before answering null

let server = null;
let extensionLastSeen = null;

// Commands waiting to be picked up by the next poll.
const pendingQueue = [];
// Commands handed to a poll, waiting on the /result post.
const inFlight = new Map(); // id -> { resolve, reject, timer, command }
// Long-poll requests (?wait=1) currently holding their response open with
// nothing queued yet -- submitCommand() hands a fresh command straight to
// one of these instead of making it wait out the rest of its poll window.
const waitingPollers = [];

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let chunks = '';
    req.on('data', (c) => { chunks += c; if (chunks.length > 5_000_000) req.destroy(); });
    req.on('end', () => resolveBody(chunks));
    req.on('error', rejectBody);
  });
}

function send(res, status, body) {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

// Called by modules/browser.mjs's execute(): enqueues a command for the
// next poll (or hands it straight to a long-poller already waiting) and
// returns a promise that resolves with whatever /result reports back (or
// rejects on timeout / relay stop).
export function submitCommand(action, args = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const id = randomUUID();
  const command = { id, action, args, queuedAt: Date.now() };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      inFlight.delete(id);
      // A command nobody picked up must not stay queued: the extension would otherwise
      // run it whenever it next polls -- a click or navigation firing minutes after the
      // model was told it failed.
      const queued = pendingQueue.indexOf(command);
      if (queued !== -1) pendingQueue.splice(queued, 1);
      reject(new Error(command.dispatchedAt
        ? `browser relay: the extension took "${action}" but did not finish it within ${timeoutMs}ms ` +
          `(the page may be unresponsive -- check the tab, then retry or try a different element)`
        : `browser relay: no response from the extension for "${action}" within ${timeoutMs}ms ` +
          `(is the extension installed, connected, and Chrome running?)`
      ));
    }, timeoutMs);
    inFlight.set(id, { resolve, reject, timer, command });

    const waiter = waitingPollers.shift();
    if (waiter) { command.dispatchedAt = Date.now(); waiter(command); }
    else pendingQueue.push(command);
  });
}

function handlePoll(req, res, url) {
  extensionLastSeen = Date.now();
  const next = pendingQueue.shift();
  if (next) { next.dispatchedAt = Date.now(); send(res, 200, { command: next }); return; }

  const wantsWait = url.searchParams.get('wait') === '1';
  if (!wantsWait) { send(res, 200, { command: null }); return; }

  // Long-poll: hold this response open until submitCommand() wakes it, or
  // until LONG_POLL_MAX_MS passes with nothing queued -- either way the
  // caller (native_host.mjs) gets a clean { command } response and loops.
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    removeWaiter(resolve);
    send(res, 200, { command: null });
  }, LONG_POLL_MAX_MS);
  const resolve = (command) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    send(res, 200, { command });
  };
  waitingPollers.push(resolve);
  req.on('close', () => {
    // Caller went away (native host process killed, Chrome closed) --
    // stop holding a resolver that can now never usefully fire.
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    removeWaiter(resolve);
  });
}

function removeWaiter(fn) {
  const idx = waitingPollers.indexOf(fn);
  if (idx !== -1) waitingPollers.splice(idx, 1);
}

async function handleResult(req, res) {
  extensionLastSeen = Date.now();
  let body;
  try { body = JSON.parse((await readBody(req)) || '{}'); }
  catch { send(res, 400, { error: 'malformed JSON body' }); return; }

  const { id, ok, data, error } = body;
  const waiting = inFlight.get(id);
  if (!waiting) { send(res, 404, { error: `no in-flight command with id "${id}" (already timed out?)` }); return; }

  clearTimeout(waiting.timer);
  inFlight.delete(id);
  if (ok) waiting.resolve(data ?? null);
  else waiting.reject(new Error(error || `extension reported failure for "${waiting.command.action}"`));
  send(res, 200, { received: true });
}

function handleStatus(req, res) {
  send(res, 200, {
    extensionConnected: isExtensionConnected(),
    lastSeen: extensionLastSeen,
    pending: pendingQueue.length,
    inFlight: inFlight.size,
    longPollersWaiting: waitingPollers.length,
  });
}

export function startRelay({ port } = {}) {
  if (server) return server;
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/poll')   { handlePoll(req, res, url); return; }
    if (req.method === 'POST' && url.pathname === '/result') { handleResult(req, res); return; }
    if (req.method === 'GET' && url.pathname === '/status') { handleStatus(req, res); return; }
    send(res, 404, { error: 'not found' });
  });
  // A failed bind (e.g. port already taken by a previous instance) shows up
  // as an 'error' event, not a throw -- without this the relay would look
  // "started" forever even though nothing is actually listening.
  server.on('error', (err) => {
    console.error('[browser relay] failed to start:', err.message);
    server = null;
  });
  server.listen(port);
  // Scripts like selfcheck.mjs that boot the kernel and expect to exit on
  // their own shouldn't be kept alive by this listener alone -- the live
  // CLI/UI process has its own refed handles (readline, its own servers)
  // that keep it running regardless, so this only matters for short scripts.
  server.unref();
  return server;
}

export function stopRelay() {
  if (!server) return;
  server.close();
  server = null;
  extensionLastSeen = null;
  for (const { reject, timer } of inFlight.values()) {
    clearTimeout(timer);
    reject(new Error('browser relay stopped'));
  }
  inFlight.clear();
  pendingQueue.length = 0;
  waitingPollers.length = 0;
}

// True once startRelay() has run and hasn't failed -- what registration's
// healthCheck() asks for (proof the relay is set up and functional), not a
// live "is the OS socket bound yet" check, which flips true asynchronously
// after listen() and would otherwise race the synchronous health check
// that registerModule() runs the instant a module is registered.
export function isListening() {
  return server !== null;
}

// True only once the extension (directly, or via native_host.mjs on its
// behalf) has actually polled recently -- what the browser_status
// capability reports as measured fact to the model.
export function isExtensionConnected() {
  return extensionLastSeen !== null && (Date.now() - extensionLastSeen) < EXTENSION_STALE_MS;
}
