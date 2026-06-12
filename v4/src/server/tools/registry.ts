import type { RiskTier } from "../../shared/events.js";

export type ToolManifest = {
  name: string;
  description: string;
  defaultTier: RiskTier;
  outputCapBytes: number;
  requiresApproval?: boolean;
};

export const TOOL_MANIFESTS: ToolManifest[] = [
  { name: "read_file", description: "Read a UTF-8 file", defaultTier: 0, outputCapBytes: 64_000 },
  { name: "list_dir", description: "List directory entries", defaultTier: 0, outputCapBytes: 32_000 },
  { name: "search_text", description: "Search files with literal or regex text", defaultTier: 0, outputCapBytes: 96_000 },
  { name: "stat_path", description: "Inspect path metadata", defaultTier: 0, outputCapBytes: 16_000 },
  { name: "hash_file", description: "Compute SHA-256 for a file", defaultTier: 0, outputCapBytes: 8_000 },
  { name: "write_file", description: "Write a scoped file", defaultTier: 2, outputCapBytes: 24_000, requiresApproval: true },
  { name: "patch_file", description: "Apply a structured patch", defaultTier: 2, outputCapBytes: 24_000, requiresApproval: true },
  { name: "delete_file", description: "Delete a scoped file", defaultTier: 2, outputCapBytes: 16_000, requiresApproval: true },
  { name: "shell_command", description: "Run a command through the risk engine", defaultTier: 1, outputCapBytes: 48_000 },
  { name: "shell_session", description: "Open an interactive terminal session", defaultTier: 2, outputCapBytes: 96_000, requiresApproval: true },
  { name: "procs", description: "Inspect processes", defaultTier: 0, outputCapBytes: 48_000 },
  { name: "log_tail", description: "Follow and merge logs", defaultTier: 0, outputCapBytes: 256_000 },
  { name: "parse_stacktrace", description: "Parse stack traces", defaultTier: 0, outputCapBytes: 64_000 },
  { name: "net_debug", description: "DNS/TCP/TLS/HTTP timing diagnostics", defaultTier: 1, outputCapBytes: 48_000 },
  { name: "provider_test", description: "Check provider health", defaultTier: 0, outputCapBytes: 24_000 },
  { name: "memory_write", description: "Write memory through prohibited-pattern filters", defaultTier: 1, outputCapBytes: 16_000 },
  { name: "memory_recall", description: "Recall memory offline", defaultTier: 0, outputCapBytes: 48_000 },
  { name: "skill_load", description: "Load a verified skill", defaultTier: 1, outputCapBytes: 24_000 },
  { name: "skill_promote", description: "Promote a skill after approval", defaultTier: 2, outputCapBytes: 16_000, requiresApproval: true },
  { name: "watcher_ack", description: "Acknowledge watcher alerts", defaultTier: 1, outputCapBytes: 12_000 }
];

export class ToolRegistry {
  #tools = new Map<string, ToolManifest>();

  constructor(manifests = TOOL_MANIFESTS) {
    for (const manifest of manifests) {
      this.#tools.set(manifest.name, manifest);
    }
  }

  get(name: string): ToolManifest | undefined {
    return this.#tools.get(name);
  }

  list(): ToolManifest[] {
    return [...this.#tools.values()];
  }

  capOutput(name: string, output: string): { output: string; capped: boolean; bytes: number } {
    const manifest = this.get(name);
    const cap = manifest?.outputCapBytes ?? 8_000;
    const bytes = Buffer.byteLength(output, "utf8");
    if (bytes <= cap) return { output, capped: false, bytes };
    return { output: output.slice(0, cap), capped: true, bytes };
  }
}
