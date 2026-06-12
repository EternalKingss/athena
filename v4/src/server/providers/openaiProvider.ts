import type { ChatProvider, ProviderChunk } from "./router.js";
import { ProviderStatusError } from "./router.js";
import { describeProviderError, readDataLines, tryParseJson } from "./streamUtils.js";

export type OpenAIProviderOptions = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

type OpenAIStreamChunk = {
  choices?: Array<{ delta?: { content?: string } }>;
};

/**
 * Streams from the OpenAI chat completions API (`/v1/chat/completions`,
 * SSE). Added to the provider router only when an OpenAI-compatible API key
 * is configured (`ATHENA_OPENAI_KEY` or `OPENAI_API_KEY`).
 */
export function createOpenAIProvider(options: OpenAIProviderOptions): ChatProvider {
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const model = options.model ?? "gpt-4o-mini";
  return {
    provider: "openai",
    model,
    async *stream(prompt: string): AsyncIterable<ProviderChunk> {
      const response = await doFetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model,
          stream: true,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!response.ok || response.body === null) {
        throw new ProviderStatusError(response.status || 500, await describeProviderError(response, "OpenAI"));
      }
      for await (const payload of readDataLines(response.body)) {
        const record = tryParseJson<OpenAIStreamChunk>(payload);
        const text = record?.choices?.[0]?.delta?.content;
        if (typeof text === "string" && text.length > 0) yield { text } satisfies ProviderChunk;
      }
    },
  };
}
