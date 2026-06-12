import { randomUUID } from "node:crypto";

export type MemoryEntry = {
  id: string;
  body: string;
  validated: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MemoryWriteResult =
  | { action: "inserted"; entry: MemoryEntry }
  | { action: "merged"; entry: MemoryEntry }
  | { action: "flagged"; entry: MemoryEntry; conflict: MemoryEntry };

export class MemoryStore {
  #entries: MemoryEntry[] = [];
  #prohibited: RegExp[] = [];

  addProhibitedPattern(pattern: string): void {
    this.#prohibited.push(new RegExp(pattern, "i"));
  }

  write(body: string, now = new Date()): MemoryWriteResult {
    if (this.#prohibited.some((pattern) => pattern.test(body))) {
      throw new Error("prohibited pattern blocked memory write");
    }

    const contradiction = this.#entries.find((entry) => contradicts(entry.body, body));
    if (contradiction) {
      const entry: MemoryEntry = {
        id: randomUUID(),
        body,
        validated: false,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      this.#entries.push(entry);
      return { action: "flagged", entry, conflict: contradiction };
    }

    const near = this.#entries.find((entry) => jaccard(entry.body, body) >= 0.5);
    if (near) {
      near.body = mergeText(near.body, body);
      near.updatedAt = now.toISOString();
      return { action: "merged", entry: near };
    }

    const entry: MemoryEntry = {
      id: randomUUID(),
      body,
      validated: false,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.#entries.push(entry);
    return { action: "inserted", entry };
  }

  recall(query: string, now = new Date()): MemoryEntry[] {
    const queryTokens = tokens(query);
    return [...this.#entries]
      .map((entry) => ({
        entry,
        score: bm25ish(queryTokens, tokens(entry.body)) * decay(entry.updatedAt, now),
      }))
      .filter((row) => row.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((row) => row.entry);
  }

  all(): MemoryEntry[] {
    return [...this.#entries];
  }
}

export function jaccard(left: string, right: string): number {
  const a = new Set(tokens(left));
  const b = new Set(tokens(right));
  const intersection = [...a].filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function tokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

function bm25ish(queryTokens: string[], bodyTokens: string[]): number {
  if (queryTokens.length === 0 || bodyTokens.length === 0) return 0;
  const body = new Set(bodyTokens);
  return queryTokens.filter((token) => body.has(token)).length / queryTokens.length;
}

function decay(updatedAt: string, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - Date.parse(updatedAt)) / 86_400_000);
  return 1 / (1 + ageDays / 90);
}

function mergeText(left: string, right: string): string {
  return left.length >= right.length ? left : right;
}

function contradicts(left: string, right: string): boolean {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  return (normalizedLeft.includes("always") && normalizedRight.includes("never")) || (normalizedLeft.includes("enabled") && normalizedRight.includes("disabled"));
}
