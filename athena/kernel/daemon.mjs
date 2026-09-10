// kernel/daemon.mjs -- the background scheduler (the heartbeat).
//
// A real assistant has to act without being asked -- "check this job
// application again in a week" only means something if something is
// actually running on a clock. This is that something.
//
// Design constraints that came directly out of planning this:
//   - State must survive the process dying. A schedule held only in memory
//     is worthless if Athena isn't running when the date arrives, so every
//     scheduled task is persisted to disk the moment it's created.
//   - A missed window fires late, it does not silently vanish. tick() finds
//     everything due *at or before* now, not *exactly* now -- if the machine
//     was off for three days, those tasks fire (late) the next time she
//     boots, rather than being skipped because the exact minute passed.
//   - One execution path. A fired task goes through the same dispatch() as
//     everything else -- same registry lookup, same health check, same
//     audit trail. The daemon doesn't get its own private way of calling
//     into modules.
//   - Idempotency. A task is marked fired (with its result recorded) the
//     moment it's dispatched, before moving to the next one, so a crash
//     mid-tick can't cause the same task to fire twice on the next tick.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PATHS } from '../paths.mjs';
import { dispatch as defaultDispatch } from './router.mjs';

function loadSchedule() {
  if (!existsSync(PATHS.schedule)) return [];
  try {
    const parsed = JSON.parse(readFileSync(PATHS.schedule, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Corrupt or partially-written file -- don't crash the daemon over it,
    // but don't silently wipe it either; treat as empty for this run so new
    // scheduling still works. The bad file stays on disk for inspection.
    return [];
  }
}

function saveSchedule(list) {
  writeFileSync(PATHS.schedule, JSON.stringify(list, null, 2));
}

export function scheduleTask({ capability, args = {}, dueAt, note = null }) {
  if (!capability || typeof capability !== 'string') {
    throw new Error('scheduleTask needs a capability name');
  }
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) {
    throw new Error(`scheduleTask: dueAt "${dueAt}" is not a valid date`);
  }
  const entry = {
    id: randomUUID(),
    capability,
    args,
    note,
    dueAt: due.toISOString(),
    createdAt: new Date().toISOString(),
    status: 'pending',
    firedAt: null,
    lastResult: null,
  };
  const list = loadSchedule();
  list.push(entry);
  saveSchedule(list);
  return entry;
}

export function cancelTask(id) {
  const list = loadSchedule();
  const entry = list.find(t => t.id === id && t.status === 'pending');
  if (!entry) return false;
  entry.status = 'cancelled';
  saveSchedule(list);
  return true;
}

export function listScheduled({ includeFired = false } = {}) {
  const list = loadSchedule();
  return includeFired ? list : list.filter(t => t.status === 'pending');
}

// Finds everything due (dueAt <= now) and still pending, dispatches each
// through the router, and persists the outcome one task at a time so a
// crash mid-tick doesn't leave a fired task looking pending (and re-firing)
// or a pending one silently skipped.
export async function tick(dispatchFn = defaultDispatch) {
  const list = loadSchedule();
  const now = Date.now();
  const fired = [];

  for (const entry of list) {
    if (entry.status !== 'pending') continue;
    if (new Date(entry.dueAt).getTime() > now) continue;

    let result;
    try {
      result = await dispatchFn(entry.capability, entry.args, {});
    } catch (e) {
      result = 'Error: ' + e.message;
    }
    entry.status = (typeof result === 'string' && result.startsWith('Error: ')) ? 'error' : 'fired';
    entry.firedAt = new Date().toISOString();
    entry.lastResult = typeof result === 'string' ? result.slice(0, 2000) : String(result);
    saveSchedule(list); // persist immediately after each task, not batched at the end
    fired.push(entry);
  }

  return fired;
}

// Starts the heartbeat. Runs one tick immediately (catches up on anything
// that came due while the process wasn't running), then on the given
// interval. Returns a stop function.
export function startDaemon({ intervalMs = 60_000, dispatchFn = defaultDispatch } = {}) {
  let stopped = false;
  tick(dispatchFn).catch(() => {});
  const handle = setInterval(() => {
    if (stopped) return;
    tick(dispatchFn).catch(() => {});
  }, intervalMs);
  if (handle.unref) handle.unref(); // don't hold the process open just for the heartbeat
  return () => { stopped = true; clearInterval(handle); };
}
