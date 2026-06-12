import type { EventBus } from "../kernel/eventBus.js";

export function ptyCapability(prebuildPresent: boolean, bus: EventBus): "pty" | "child_process" {
  if (prebuildPresent) return "pty";
  bus.emit({ type: "capability_changed", capability: "pty", available: false, reason: "prebuild missing; child_process fallback active" });
  return "child_process";
}

export function mergeLogLines(sources: Array<{ source: string; ts: string; line: string }>): Array<{ source: string; ts: string; line: string }> {
  return [...sources].sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts));
}

export function parseStacktrace(text: string): { language: "node" | "python" | "java" | "rust" | "go" | "dotnet" | "unknown"; frames: string[] } {
  const frames = text.split(/\r?\n/).filter((line) => /^\s*(at |File "|goroutine|thread '|---)/.test(line));
  if (text.includes("Traceback (most recent call last)")) return { language: "python", frames };
  if (/^\s*at\s/m.test(text)) return { language: text.includes("System.") ? "dotnet" : "node", frames };
  if (text.includes("goroutine")) return { language: "go", frames };
  if (text.includes("thread '")) return { language: "rust", frames };
  if (text.includes("Exception in thread")) return { language: "java", frames };
  return { language: "unknown", frames };
}

export type NetDebugResult = {
  host: string;
  dnsMs: number;
  tcpMs: number;
  tlsMs?: number;
  httpMs?: number;
};

export function summarizeNetDebug(host: string, timings: Partial<Omit<NetDebugResult, "host">>): NetDebugResult {
  return {
    host,
    dnsMs: timings.dnsMs ?? 0,
    tcpMs: timings.tcpMs ?? 0,
    ...(timings.tlsMs === undefined ? {} : { tlsMs: timings.tlsMs }),
    ...(timings.httpMs === undefined ? {} : { httpMs: timings.httpMs }),
  };
}
