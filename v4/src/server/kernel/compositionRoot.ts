import { randomUUID } from "node:crypto";
import type { AlertSeverity, AlertState } from "../../shared/events.js";
import { athenaError } from "../../shared/errors.js";
import { ApprovalManager } from "../approvals/sessionLeases.js";
import { CoralLog, type CoralEntry } from "../coral/coralLog.js";
import { ErrorHub, type ErrorSink } from "../errors/errorHub.js";
import { InstinctTracker, type Instinct } from "../memory/instincts.js";
import { MemoryStore, type Embedder, type MemoryWriteResult } from "../memory/memoryStore.js";
import { ProviderHealth } from "../providers/providerHealth.js";
import { StreamingRouter, type ChatProvider } from "../providers/router.js";
import { classifyCommand } from "../risk/riskEngine.js";
import { SkillRegistry } from "../skills/skillTrust.js";
import { Repository, type AuditRecord } from "../storage/repository.js";
import { ToolRegistry } from "../tools/registry.js";
import { TurnEngine } from "../turns/turnEngine.js";
import { WatcherEngine, type Alert, type MonitorName } from "../watchers/watcherEngine.js";
import { EventBus } from "./eventBus.js";
import { DbWorker } from "./dbWorker.js";

export type CompositionRootOptions = {
  token?: string;
  maxReplayBytes?: number;
  dbPath?: string;
  providers?: ChatProvider[];
  embedder?: Embedder;
};

export type Services = {
  writeMemory(body: string): Promise<MemoryWriteResult>;
  observeInstinct(domain: string, body: string, sessionId: string, delta: number, machineId?: string): Promise<Instinct | undefined>;
  appendCoral(platform: string, body: string): Promise<CoralEntry>;
  raiseAlert(monitor: MonitorName, severity: AlertSeverity): Promise<Alert>;
  transitionAlert(id: string, state: AlertState): Promise<Alert>;
  recordAudit(record: AuditRecord): Promise<void>;
};

export type CompositionRoot = {
  bus: EventBus;
  db: DbWorker;
  token: string;
  repo: Repository;
  memory: MemoryStore;
  instincts: InstinctTracker;
  skills: SkillRegistry;
  coral: CoralLog;
  watchers: WatcherEngine;
  providerHealth: ProviderHealth;
  approvals: ApprovalManager;
  tools: ToolRegistry;
  errors: ErrorHub;
  risk: typeof classifyCommand;
  router: StreamingRouter;
  turnEngine: TurnEngine;
  services: Services;
  init: () => Promise<void>;
  close: () => Promise<void>;
};

export function createCompositionRoot(options: CompositionRootOptions = {}): CompositionRoot {
  const bus = new EventBus(options.maxReplayBytes);
  const db = new DbWorker(options.dbPath === undefined ? {} : { dbPath: options.dbPath });
  const repo = new Repository(db);
  const token = options.token ?? randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

  const memory = new MemoryStore(options.embedder);
  const instincts = new InstinctTracker();
  const skills = new SkillRegistry();
  const coral = new CoralLog();
  const watchers = new WatcherEngine();
  const providerHealth = new ProviderHealth();
  const approvals = new ApprovalManager();
  const tools = new ToolRegistry();

  const errorSink: ErrorSink = (record) => {
    void repo.insertError(record).catch((cause: unknown) => {
      bus.emit({ type: "error_detail", error: athenaError("storage.error_persist_failed", "storage", "error", cause instanceof Error ? cause.message : String(cause)) });
    });
  };
  const errors = new ErrorHub(bus, errorSink);

  const router = new StreamingRouter(options.providers ?? [], providerHealth, {
    onHealthChange: (state) => {
      void repo.saveProviderHealth(state).catch((cause: unknown) => {
        errors.swallow(athenaError("storage.provider_health_failed", "storage", "warning", cause instanceof Error ? cause.message : String(cause)));
      });
    },
  });
  const turnEngine = new TurnEngine(bus, { router });

  const services: Services = {
    writeMemory: async (body) => {
      const result = memory.write(body);
      await repo.upsertMemory(result.entry);
      bus.emit({ type: "memory_updated", id: result.entry.id, action: result.action });
      return result;
    },
    observeInstinct: async (domain, body, sessionId, delta, machineId) => {
      const outcome = instincts.observe(domain, body, sessionId, delta, machineId);
      const event = instincts.lastEvent();
      if (event) {
        await repo.appendInstinctEvent(event);
        const snapshot = instincts.snapshot().find((candidate) => candidate.id === event.instinctId);
        if (snapshot) await repo.upsertInstinct(snapshot);
        bus.emit({ type: "instinct_event", id: event.instinctId, action: event.action, confidence: event.confidence });
      }
      return outcome;
    },
    appendCoral: async (platform, body) => {
      const entry = coral.append(platform, body);
      await repo.appendCoral(entry);
      bus.emit({ type: "coral_update", version: entry.version, platform: entry.platform });
      return entry;
    },
    raiseAlert: async (monitor, severity) => {
      const alert = watchers.raise(monitor, severity);
      await repo.saveAlert(alert);
      await repo.appendAlertEvent(alert.id, alert.state);
      bus.emit({ type: "alert_event", alertId: alert.id, monitor, state: alert.state, severity });
      return alert;
    },
    transitionAlert: async (id, state) => {
      const alert = watchers.transition(id, state);
      await repo.saveAlert(alert);
      await repo.appendAlertEvent(alert.id, state);
      bus.emit({ type: "alert_event", alertId: alert.id, monitor: alert.monitor, state, severity: alert.severity });
      return alert;
    },
    recordAudit: async (record) => {
      await repo.appendAudit(record);
    },
  };

  return {
    bus,
    db,
    token,
    repo,
    memory,
    instincts,
    skills,
    coral,
    watchers,
    providerHealth,
    approvals,
    tools,
    errors,
    risk: classifyCommand,
    router,
    turnEngine,
    services,
    init: async () => {
      await db.ping();
      memory.hydrate(await repo.loadMemory());
      instincts.hydrate(await repo.loadInstincts());
      skills.hydrate(await repo.loadSkills());
      coral.hydrate(await repo.loadCoral());
      watchers.hydrate(await repo.loadAlerts());
      providerHealth.hydrate(await repo.loadProviderHealth());
    },
    close: async () => {
      await db.close();
    },
  };
}
