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

export class WatcherEngine {
  #alerts: Alert[] = [];
  #queued: Alert[] = [];
  #inTurn = false;

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
    const existing = this.#alerts.find((alert) => now.getTime() - Date.parse(alert.createdAt) <= 5 * 60 * 1000);
    const alert: Alert =
      existing === undefined
        ? { id: randomUUID(), monitor, severity, state: "created", createdAt: now.toISOString(), related: [] }
        : {
            ...existing,
            related: [...new Set([...existing.related, monitor])],
            severity: severityRank(severity) > severityRank(existing.severity) ? severity : existing.severity,
          };

    if (this.#inTurn) {
      this.#queued.push(alert);
    } else if (existing === undefined) {
      this.#alerts.push(alert);
    } else {
      this.#alerts = this.#alerts.map((candidate) => (candidate.id === existing.id ? alert : candidate));
    }
    return alert;
  }

  transition(id: string, state: AlertState): Alert {
    const alert = this.#alerts.find((candidate) => candidate.id === id);
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
