import type { ChatProvider, ProviderChunk } from "../providers/router.js";
import { ProviderStatusError } from "../providers/router.js";

export type LlamaProviderOptions = {
  baseUrl: string;
  model?: string;
  nPredict?: number;
  fetchImpl?: typeof fetch;
};

/**
 * Streams from a vendored llama.cpp server (`/completion`, SSE). Added to the
 * provider router only when a base URL is configured (e.g. when llama-server is
 * running from the drive); otherwise Athena stays on deterministic L2 answers.
 */
export function createLlamaProvider(options: LlamaProviderOptions): ChatProvider {
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  return {
    provider: "llama",
    model: options.model ?? "local",
    async *stream(prompt: string): AsyncIterable<ProviderChunk> {
      const response = await doFetch(`${baseUrl}/completion`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, stream: true, n_predict: options.nPredict ?? 512 }),
      });
      if (!response.ok || response.body === null) {
        throw new ProviderStatusError(response.status || 500, `llama-server returned ${response.status}`);
      }
      for await (const event of readServerSentEvents(response.body)) {
        if (event.stop === true) return;
        if (typeof event.content === "string" && event.content.length > 0) yield { text: event.content } satisfies ProviderChunk;
      }
    },
  };
}

type SseRecord = { content?: string; stop?: boolean };

async function* readServerSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseRecord> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      const record = tryParse(payload);
      if (record !== undefined) yield record;
    }
  }
}

function tryParse(payload: string): SseRecord | undefined {
  try {
    return JSON.parse(payload) as SseRecord;
  } catch {
    return undefined;
  }
}
