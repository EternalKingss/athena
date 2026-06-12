export type EventSeq = number;

export type Severity = "info" | "warning" | "error" | "critical";

export type AthenaError = {
  code: string;
  source: string;
  severity: Severity;
  message: string;
  hint?: string;
};

export type StorageMode = "wal" | "delete" | "readonly";

export type ProviderState = {
  provider: string;
  model: string;
  failureCount: number;
  blockedUntil?: string;
};

export type CapabilityName =
  | "sqlite"
  | "sqlite_fts5"
  | "websocket_replay"
  | "pty"
  | "local_llm"
  | "embeddings";

export type CapabilityChangedEvent = SequencedEvent<{
  type: "capability_changed";
  capability: CapabilityName;
  available: boolean;
  reason?: string;
}>;

export type SequencedEvent<T extends { type: string }> = T & {
  seq: EventSeq;
  ts: string;
};

export type ServerEvent =
  | SequencedEvent<{ type: "boot_started"; version: string }>
  | SequencedEvent<{ type: "boot_ready"; storageMode?: StorageMode }>
  | SequencedEvent<{ type: "mode_changed"; mode: "offline" | "local" | "cloud"; reason: string }>
  | SequencedEvent<{ type: "text_delta"; id: string; text: string }>
  | SequencedEvent<{ type: "tool_started"; id: string; name: string; tier: 0 | 1 | 2 }>
  | SequencedEvent<{ type: "tool_finished"; id: string; ok: boolean; bytes: number }>
  | SequencedEvent<{ type: "approval_required"; id: string; tool: string; reason: string; preview: string }>
  | SequencedEvent<{ type: "approval_resolved"; id: string; approved: boolean; grantId?: string }>
  | SequencedEvent<{ type: "failover"; from: ProviderState; to: ProviderState; reason: string }>
  | SequencedEvent<{ type: "storage_mode"; mode: StorageMode; reason?: string }>
  | SequencedEvent<{ type: "error_detail"; error: AthenaError }>
  | CapabilityChangedEvent;

export type ClientEvent =
  | { type: "chat_submit"; text: string }
  | { type: "approval_response"; id: string; approved: boolean; forSession?: boolean }
  | { type: "stop_turn"; reason?: string }
  | { type: "ping" };

export type ReplayRequest = {
  token: string;
  since?: EventSeq;
};
