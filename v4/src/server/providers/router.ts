import type { EventBus } from "../kernel/eventBus.js";
import { ProviderHealth, type ProviderKey } from "./providerHealth.js";
import { athenaError } from "../../shared/errors.js";
import type { ProviderState } from "../../shared/events.js";

export type ProviderChunk = {
  text: string;
};

export type ChatProvider = ProviderKey & {
  stream: (prompt: string) => AsyncIterable<ProviderChunk>;
};

export class ProviderStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProviderStatusError";
  }
}

export type RouterOptions = {
  onHealthChange?: (state: ProviderState) => void;
};

export class StreamingRouter {
  constructor(
    private readonly providers: ChatProvider[],
    private readonly health = new ProviderHealth(),
    private readonly options: RouterOptions = {},
  ) {}

  async *stream(prompt: string, bus: EventBus): AsyncIterable<ProviderChunk> {
    let lastError: Error | undefined;
    for (const provider of this.providers) {
      if (this.health.isBlocked(provider)) continue;
      try {
        for await (const chunk of provider.stream(prompt)) {
          yield chunk;
        }
        this.options.onHealthChange?.(this.health.recordSuccess(provider));
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const status = error instanceof ProviderStatusError ? error.status : 500;
        const from = this.health.recordFailure(provider, status);
        this.options.onHealthChange?.(from);
        const next = this.providers.find((candidate) => candidate !== provider && !this.health.isBlocked(candidate));
        if (next) {
          bus.emit({ type: "failover", from, to: this.health.get(next), reason: lastError.message });
          continue;
        }
      }
    }
    bus.emit({
      type: "error_detail",
      error: athenaError("provider.exhausted", "providers", "error", lastError?.message ?? "No provider available", "Check provider health or offline mode."),
    });
  }
}

export function createMockProvider(provider: string, model: string, chunks: string[], failStatus?: number): ChatProvider {
  return {
    provider,
    model,
    async *stream() {
      if (failStatus !== undefined) throw new ProviderStatusError(failStatus, `${provider} ${model} failed`);
      for (const text of chunks) yield { text };
    },
  };
}
