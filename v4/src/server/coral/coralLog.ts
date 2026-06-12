export type CoralEntry = {
  version: number;
  platform: string;
  body: string;
};

export class CoralLog {
  #entries: CoralEntry[] = [];
  #pending: CoralEntry[] = [];

  append(platform: string, body: string): CoralEntry {
    const entry = { version: this.#entries.length + this.#pending.length + 1, platform, body };
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
