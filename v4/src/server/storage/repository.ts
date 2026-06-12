import { randomUUID } from "node:crypto";
import type { ProviderState } from "../../shared/events.js";
import type { DbWorker } from "../kernel/dbWorker.js";
import type { CoralEntry } from "../coral/coralLog.js";
import type { ErrorRecord } from "../errors/errorHub.js";
import type { Instinct, InstinctEvent } from "../memory/instincts.js";
import type { MemoryEntry } from "../memory/memoryStore.js";
import type { Skill } from "../skills/skillTrust.js";
import type { Alert } from "../watchers/watcherEngine.js";

export type AuditRecord = {
  id: string;
  action: string;
  outcome: string;
  scopeHash?: string;
  autoApproved: boolean;
  reason?: string;
};

/**
 * Typed persistence over the SQLite schema. All subsystems keep their fast in-memory
 * state; the repository is the durable mirror that hydrates them on boot and is
 * written through on every mutation, so nothing dies on restart.
 */
export class Repository {
  constructor(private readonly db: DbWorker) {}

  // ---- memory ----
  async loadMemory(): Promise<MemoryEntry[]> {
    const rows = await this.db.all<{ id: string; body: string; validated: number; created_at: string; updated_at: string }>(
      "SELECT id, body, validated, created_at, updated_at FROM memory_entries ORDER BY created_at",
    );
    return rows.map((row) => ({ id: row.id, body: row.body, validated: row.validated === 1, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  async upsertMemory(entry: MemoryEntry): Promise<void> {
    await this.db.run(
      "INSERT INTO memory_entries (id, body, validated, created_at, updated_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET body=excluded.body, validated=excluded.validated, updated_at=excluded.updated_at",
      [entry.id, entry.body, entry.validated ? 1 : 0, entry.createdAt, entry.updatedAt],
    );
  }

  // ---- instincts ----
  async loadInstincts(): Promise<Instinct[]> {
    const rows = await this.db.all<{ id: string; domain: string; body: string; confidence: number; seen_sessions: number; machine_id: string | null }>(
      "SELECT id, domain, body, confidence, seen_sessions, machine_id FROM instincts",
    );
    return rows.map((row) => ({
      id: row.id,
      domain: row.domain,
      body: row.body,
      confidence: row.confidence,
      seenSessions: placeholderSessions(row.seen_sessions),
      ...(row.machine_id === null ? {} : { machineId: row.machine_id }),
    }));
  }

  async upsertInstinct(instinct: Instinct): Promise<void> {
    await this.db.run(
      "INSERT INTO instincts (id, domain, body, confidence, seen_sessions, machine_id) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET confidence=excluded.confidence, seen_sessions=excluded.seen_sessions",
      [instinct.id, instinct.domain, instinct.body, instinct.confidence, instinct.seenSessions.size, instinct.machineId ?? null],
    );
  }

  async appendInstinctEvent(event: InstinctEvent): Promise<void> {
    await this.db.run(
      "INSERT INTO instinct_events (id, instinct_id, action, confidence, created_at) VALUES (?, ?, ?, ?, ?)",
      [event.id, event.instinctId, event.action, event.confidence, new Date().toISOString()],
    );
  }

  countInstinctEvents(): Promise<number> {
    return this.#count("instinct_events");
  }

  // ---- skills ----
  async loadSkills(): Promise<Skill[]> {
    const skills = await this.db.all<{ id: string; name: string; verified: number }>("SELECT id, name, verified FROM skills");
    const result: Skill[] = [];
    for (const skill of skills) {
      const versions = await this.db.all<{ version: number; body: string; uses: number; successes: number; failures: number }>(
        "SELECT version, body, uses, successes, failures FROM skill_versions WHERE skill_id = ? ORDER BY version",
        [skill.id],
      );
      result.push({ id: skill.id, name: skill.name, verified: skill.verified === 1, versions: versions.map((version) => ({ ...version })) });
    }
    return result;
  }

  async saveSkill(skill: Skill): Promise<void> {
    await this.db.run(
      "INSERT INTO skills (id, name, verified) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET verified=excluded.verified",
      [skill.id, skill.name, skill.verified ? 1 : 0],
    );
    for (const version of skill.versions) {
      await this.db.run(
        "INSERT INTO skill_versions (id, skill_id, version, body, uses, successes, failures) VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET body=excluded.body, uses=excluded.uses, successes=excluded.successes, failures=excluded.failures",
        [`${skill.id}:${version.version}`, skill.id, version.version, version.body, version.uses, version.successes, version.failures],
      );
    }
  }

  // ---- coral ----
  async loadCoral(): Promise<CoralEntry[]> {
    const rows = await this.db.all<{ version: number; platform: string; body: string }>("SELECT version, platform, body FROM coral_log ORDER BY version");
    return rows.map((row) => ({ version: row.version, platform: row.platform, body: row.body }));
  }

  async appendCoral(entry: CoralEntry): Promise<void> {
    await this.db.run(
      "INSERT INTO coral_log (version, platform, body, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(version) DO NOTHING",
      [entry.version, entry.platform, entry.body, new Date().toISOString()],
    );
  }

  // ---- alerts ----
  async loadAlerts(): Promise<Alert[]> {
    const rows = await this.db.all<{ id: string; monitor: string; severity: string; state: string; created_at: string }>(
      "SELECT id, monitor, severity, state, created_at FROM alerts",
    );
    return rows.map((row) => ({
      id: row.id,
      monitor: row.monitor as Alert["monitor"],
      severity: row.severity as Alert["severity"],
      state: row.state as Alert["state"],
      createdAt: row.created_at,
      related: [],
    }));
  }

  async saveAlert(alert: Alert): Promise<void> {
    await this.db.run(
      "INSERT INTO alerts (id, monitor, severity, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET severity=excluded.severity, state=excluded.state, updated_at=excluded.updated_at",
      [alert.id, alert.monitor, alert.severity, alert.state, alert.createdAt, new Date().toISOString()],
    );
  }

  async appendAlertEvent(alertId: string, state: string): Promise<void> {
    await this.db.run("INSERT INTO alert_events (id, alert_id, state, created_at) VALUES (?, ?, ?, ?)", [randomUUID(), alertId, state, new Date().toISOString()]);
  }

  // ---- audit ----
  async appendAudit(record: AuditRecord): Promise<void> {
    await this.db.run(
      "INSERT INTO audit_log (id, ts, action, outcome, scope_hash, auto_approved, reason) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [record.id, new Date().toISOString(), record.action, record.outcome, record.scopeHash ?? null, record.autoApproved ? 1 : 0, record.reason ?? null],
    );
  }

  countAudit(): Promise<number> {
    return this.#count("audit_log");
  }

  // ---- errors ----
  async insertError(record: ErrorRecord): Promise<void> {
    await this.db.run(
      "INSERT INTO errors (id, code, source, severity, message, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [record.id, record.error.code, record.error.source, record.error.severity, record.error.message, record.createdAt],
    );
  }

  countErrors(): Promise<number> {
    return this.#count("errors");
  }

  // ---- provider health ----
  async loadProviderHealth(): Promise<ProviderState[]> {
    const rows = await this.db.all<{ provider: string; model: string; failure_count: number; blocked_until: string | null }>(
      "SELECT provider, model, failure_count, blocked_until FROM provider_health",
    );
    return rows.map((row) => ({
      provider: row.provider,
      model: row.model,
      failureCount: row.failure_count,
      ...(row.blocked_until === null ? {} : { blockedUntil: row.blocked_until }),
    }));
  }

  async saveProviderHealth(state: ProviderState): Promise<void> {
    await this.db.run(
      "INSERT INTO provider_health (provider, model, failure_count, blocked_until) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(provider, model) DO UPDATE SET failure_count=excluded.failure_count, blocked_until=excluded.blocked_until",
      [state.provider, state.model, state.failureCount, state.blockedUntil ?? null],
    );
  }

  async #count(table: string): Promise<number> {
    const row = await this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
    return row?.n ?? 0;
  }
}

function placeholderSessions(count: number): Set<string> {
  const sessions = new Set<string>();
  for (let index = 0; index < count; index += 1) sessions.add(`hydrated-${index}`);
  return sessions;
}
