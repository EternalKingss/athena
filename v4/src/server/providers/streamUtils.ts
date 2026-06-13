/**
 * Shared helpers for cloud ChatProvider adapters (OpenAI, Anthropic, ...).
 * Kept separate from `offline/llamaProvider.ts` so the existing, tested
 * llama SSE path is left untouched.
 */

/**
 * Reads `data: ...` lines from a Server-Sent-Events body, yielding the raw
 * payload (text after `data:`, trimmed). Non-`data:` lines (e.g. `event:`,
 * `id:`, blank separators) are skipped. Stops on a `[DONE]` payload.
 */
export async function* readDataLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
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
      yield payload;
    }
  }
}

/** Best-effort human-readable description of a failed HTTP response. */
export async function describeProviderError(response: Response, label: string): Promise<string> {
  try {
    const body = await response.text();
    return body.length > 0 ? `${label} returned ${response.status}: ${body.slice(0, 200)}` : `${label} returned ${response.status}`;
  } catch {
    return `${label} returned ${response.status}`;
  }
}

/** Parses a JSON payload, returning `undefined` instead of throwing on malformed input. */
export function tryParseJson<T>(payload: string): T | undefined {
  try {
    return JSON.parse(payload) as T;
  } catch {
    return undefined;
  }
}
