export type CoralEntry = {
  version: number;
  platform: string;
  body: string;
};

export class CoralLog {
  #entries: CoralEntry[] = [];
  #pending: CoralEntry[] = [];

  /** Seed already-persisted (committed) CORAL entries on boot. */
  hydrate(entries: CoralEntry[]): void {
    this.#entries = entries.map((entry) => ({ ...entry }));
  }

  append(platform: string, body: string): CoralEntry {
    const nextVersion = Math.max(0, ...this.#entries.map((entry) => entry.version), ...this.#pending.map((entry) => entry.version)) + 1;
    const entry = { version: nextVersion, platform, body };
    this.#pending.push(entry);
    return entry;
  }

  pullAtTurnBoundary(platform: string): CoralEntry[] {
    this.#entries.push(...this.#pending);
    this.#pending = [];
    return this.#entries.filter((entry) => entry.platform === platform || entry.platform === "all");
  }

  persisted(): CoralEntry[] {
    return [...this.#entries];
  }
}
