import { randomUUID } from "node:crypto";
import type { AlertSeverity, AlertState } from "../../shared/events.js";

export type MonitorName =
  | "disk_low"
  | "kp41"
  | "temp_high"
  | "net_change"
  | "ram_pressure"
  | "cpu_spike"
  | "battery_drain"
  | "login_failures"
  | "pending_reboot";

export type MonitorSpec = {
  name: MonitorName;
  intervalMinutes: number;
  critical?: boolean;
};

export type Alert = {
  id: string;
  monitor: MonitorName;
  severity: AlertSeverity;
  state: AlertState;
  createdAt: string;
  related: MonitorName[];
};

export const MONITORS: MonitorSpec[] = [
  { name: "disk_low", intervalMinutes: 5 },
  { name: "kp41", intervalMinutes: 10, critical: true },
  { name: "temp_high", intervalMinutes: 3, critical: true },
  { name: "net_change", intervalMinutes: 2 },
  { name: "ram_pressure", intervalMinutes: 3 },
  { name: "cpu_spike", intervalMinutes: 2 },
  { name: "battery_drain", intervalMinutes: 5 },
  { name: "login_failures", intervalMinutes: 5 },
  { name: "pending_reboot", intervalMinutes: 60 },
];

// SEMANTICS: only *related* alerts inside the 5-minute window merge. Relatedness is
// defined by correlation group; unrelated alerts (e.g. a disk warning and a failed
// login) stay distinct events.
const CORRELATION_GROUPS: MonitorName[][] = [
  ["cpu_spike", "ram_pressure", "temp_high", "disk_low", "battery_drain"],
  ["kp41", "pending_reboot"],
  ["net_change"],
  ["login_failures"],
];

const MERGE_WINDOW_MS = 5 * 60 * 1000;
const ACTIVE_STATES = new Set<AlertState>(["created", "shown"]);

export class WatcherEngine {
  #alerts: Alert[] = [];
  #queued: Alert[] = [];
  #inTurn = false;

  /** Seed persisted alerts on boot. */
  hydrate(alerts: Alert[]): void {
    this.#alerts = alerts.map((alert) => ({ ...alert, related: [...alert.related] }));
  }

  beginTurn(): void {
    this.#inTurn = true;
  }

  endTurn(): Alert[] {
    this.#inTurn = false;
    const drained = this.#queued.splice(0);
    this.#alerts.push(...drained);
    return drained;
  }

  raise(monitor: MonitorName, severity: AlertSeverity, now = new Date()): Alert {
    const candidates = [...this.#alerts, ...this.#queued];
    const existing = candidates.find(
      (alert) =>
        ACTIVE_STATES.has(alert.state) &&
        now.getTime() - Date.parse(alert.createdAt) <= MERGE_WINDOW_MS &&
        alertRelatesTo(alert, monitor),
    );

    const alert: Alert =
      existing === undefined
        ? { id: randomUUID(), monitor, severity, state: "created", createdAt: now.toISOString(), related: [] }
        : {
            ...existing,
            related: [...new Set([...existing.related, monitor])],
            severity: severityRank(severity) > severityRank(existing.severity) ? severity : existing.severity,
          };

    if (existing === undefined) {
      if (this.#inTurn) this.#queued.push(alert);
      else this.#alerts.push(alert);
    } else if (this.#queued.some((candidate) => candidate.id === existing.id)) {
      this.#queued = this.#queued.map((candidate) => (candidate.id === existing.id ? alert : candidate));
    } else {
      this.#alerts = this.#alerts.map((candidate) => (candidate.id === existing.id ? alert : candidate));
    }
    return alert;
  }

  transition(id: string, state: AlertState): Alert {
    const alert = [...this.#alerts, ...this.#queued].find((candidate) => candidate.id === id);
    if (!alert) throw new Error(`Unknown alert: ${id}`);
    alert.state = state;
    return alert;
  }

  checkpointRequired(alert: Alert): boolean {
    return alert.severity === "critical" || MONITORS.some((monitor) => monitor.name === alert.monitor && monitor.critical === true);
  }

  alerts(): Alert[] {
    return [...this.#alerts];
  }
}

function severityRank(severity: AlertSeverity): number {
  return severity === "critical" ? 3 : severity === "high" ? 2 : 1;
}

function areRelated(left: MonitorName, right: MonitorName): boolean {
  if (left === right) return true;
  return CORRELATION_GROUPS.some((group) => group.includes(left) && group.includes(right));
}

function alertRelatesTo(alert: Alert, monitor: MonitorName): boolean {
  return areRelated(alert.monitor, monitor) || alert.related.some((related) => areRelated(related, monitor));
}
