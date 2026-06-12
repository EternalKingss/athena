import type { ProviderState } from "../../shared/events.js";

const BLOCK_MS = 15 * 60 * 1000;
const BLOCKING_STATUS = new Set([401, 403, 429]);

export type ProviderKey = {
  provider: string;
  model: string;
};

export class ProviderHealth {
  #states = new Map<string, ProviderState>();

  /** Seed persisted health (including active blocks) on boot. */
  hydrate(states: ProviderState[]): void {
    for (const state of states) this.#states.set(this.#key(state), { ...state });
  }

  snapshot(): ProviderState[] {
    return [...this.#states.values()];
  }

  recordSuccess(key: ProviderKey): ProviderState {
    const state: ProviderState = { ...key, failureCount: 0 };
    this.#states.set(this.#key(key), state);
    return state;
  }

  recordFailure(key: ProviderKey, status: number, now = new Date()): ProviderState {
    const previous = this.get(key);
    // "Two *consecutive* blocking errors" — a non-blocking failure breaks the streak.
    const failureCount = BLOCKING_STATUS.has(status) ? previous.failureCount + 1 : 0;
    const blockedUntil = failureCount >= 2 ? new Date(now.getTime() + BLOCK_MS).toISOString() : undefined;
    const state: ProviderState = {
      ...key,
      failureCount,
      ...(blockedUntil === undefined ? {} : { blockedUntil }),
    };
    this.#states.set(this.#key(key), state);
    return state;
  }

  isBlocked(key: ProviderKey, now = new Date()): boolean {
    const blockedUntil = this.get(key).blockedUntil;
    return blockedUntil !== undefined && Date.parse(blockedUntil) > now.getTime();
  }

  get(key: ProviderKey): ProviderState {
    return this.#states.get(this.#key(key)) ?? { ...key, failureCount: 0 };
  }

  #key(key: ProviderKey): string {
    return `${key.provider}:${key.model}`;
  }
}
