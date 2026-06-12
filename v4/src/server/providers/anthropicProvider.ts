import type { ChatProvider, ProviderChunk } from "./router.js";
import { ProviderStatusError } from "./router.js";
import { describeProviderError, readDataLines, tryParseJson } from "./streamUtils.js";

export type AnthropicProviderOptions = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
};

type AnthropicStreamEvent = {
  type?: string;
  delta?: { type?: string; text?: string };
  error?: { message?: string };
};

/**
 * Streams from the Anthropic Messages API (`/v1/messages`, SSE). Added to
 * the provider router only when `ANTHROPIC_API_KEY` is configured.
 */
export function createAnthropicProvider(options: AnthropicProviderOptions): ChatProvider {
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/$/, "");
  const model = options.model ?? "claude-haiku-4-5-20251001";
  return {
    provider: "anthropic",
    model,
    async *stream(prompt: string): AsyncIterable<ProviderChunk> {
      const response = await doFetch(`${baseUrl}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: options.maxTokens ?? 1024,
          stream: true,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!response.ok || response.body === null) {
        throw new ProviderStatusError(response.status || 500, await describeProviderError(response, "Anthropic"));
      }
      for await (const payload of readDataLines(response.body)) {
        const record = tryParseJson<AnthropicStreamEvent>(payload);
        if (!record) continue;
        if (record.type === "error") {
          throw new ProviderStatusError(500, `Anthropic stream error: ${record.error?.message ?? "unknown"}`);
        }
        const text = record.type === "content_block_delta" && record.delta?.type === "text_delta" ? record.delta.text : undefined;
        if (typeof text === "string" && text.length > 0) yield { text } satisfies ProviderChunk;
      }
    },
  };
}
