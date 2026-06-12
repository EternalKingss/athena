import { randomUUID } from "node:crypto";

export type Instinct = {
  id: string;
  domain: string;
  body: string;
  confidence: number;
  seenSessions: Set<string>;
  machineId?: string;
};

export type InstinctEvent = {
  id: string;
  instinctId: string;
  action: "promoted" | "reinforced" | "retired";
  confidence: number;
};

export class InstinctTracker {
  #instincts = new Map<string, Instinct>();
  #events: InstinctEvent[] = [];

  observe(domain: string, body: string, sessionId: string, confidenceDelta: number, machineId?: string): Instinct | undefined {
    const key = `${domain}:${body}:${machineId ?? "global"}`;
    const existing = this.#instincts.get(key) ?? {
      id: randomUUID(),
      domain,
      body,
      confidence: 0,
      seenSessions: new Set<string>(),
      ...(machineId === undefined ? {} : { machineId }),
    };
    existing.seenSessions.add(sessionId);
    existing.confidence = clamp(existing.confidence + confidenceDelta);
    this.#instincts.set(key, existing);

    if (existing.confidence < 40 && existing.seenSessions.size >= 3) {
      this.#events.push(event(existing.id, "retired", existing.confidence));
      return existing;
    }
    if (existing.confidence >= 85 && existing.seenSessions.size >= 3) {
      this.#events.push(event(existing.id, "promoted", existing.confidence));
      return existing;
    }
    this.#events.push(event(existing.id, "reinforced", existing.confidence));
    return undefined;
  }

  events(): InstinctEvent[] {
    return [...this.#events];
  }
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function event(instinctId: string, action: InstinctEvent["action"], confidence: number): InstinctEvent {
  return { id: randomUUID(), instinctId, action, confidence };
}
