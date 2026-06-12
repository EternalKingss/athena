import { describe, expect, it } from "vitest";
import { createAnthropicProvider } from "../src/server/providers/anthropicProvider.js";
import { buildCloudProviders } from "../src/server/providers/cloudProviders.js";
import { createOpenAIProvider } from "../src/server/providers/openaiProvider.js";
import { ProviderStatusError } from "../src/server/providers/router.js";

function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

describe("cloud providers", () => {
  it("openai: streams delta content and stops on [DONE]", async () => {
    const fetchImpl = async () =>
      sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n`,
        `data: [DONE]\n\n`,
      ]);
    const provider = createOpenAIProvider({ apiKey: "test", fetchImpl });
    const chunks: string[] = [];
    for await (const chunk of provider.stream("hi")) chunks.push(chunk.text);
    expect(chunks.join("")).toBe("Hello");
    expect(provider.provider).toBe("openai");
  });

  it("openai: maps 429 to ProviderStatusError for failover", async () => {
    const fetchImpl = async () => new Response("rate limited", { status: 429 });
    const provider = createOpenAIProvider({ apiKey: "test", fetchImpl });
    await expect(async () => {
      const chunks: string[] = [];
      for await (const chunk of provider.stream("hi")) chunks.push(chunk.text);
    }).rejects.toBeInstanceOf(ProviderStatusError);
  });

  it("anthropic: streams text_delta content blocks and ignores other events", async () => {
    const fetchImpl = async () =>
      sseResponse([
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } })}\n\n`,
        `event: ping\ndata: ${JSON.stringify({ type: "ping" })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "lo" } })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      ]);
    const provider = createAnthropicProvider({ apiKey: "test", fetchImpl });
    const chunks: string[] = [];
    for await (const chunk of provider.stream("hi")) chunks.push(chunk.text);
    expect(chunks.join("")).toBe("Hello");
    expect(provider.provider).toBe("anthropic");
  });

  it("anthropic: maps 401 to ProviderStatusError for failover", async () => {
    const fetchImpl = async () => new Response("bad key", { status: 401 });
    const provider = createAnthropicProvider({ apiKey: "test", fetchImpl });
    await expect(async () => {
      const chunks: string[] = [];
      for await (const chunk of provider.stream("hi")) chunks.push(chunk.text);
    }).rejects.toBeInstanceOf(ProviderStatusError);
  });

  it("anthropic: mid-stream error event throws", async () => {
    const fetchImpl = async () =>
      sseResponse([`event: error\ndata: ${JSON.stringify({ type: "error", error: { message: "overloaded" } })}\n\n`]);
    const provider = createAnthropicProvider({ apiKey: "test", fetchImpl });
    await expect(async () => {
      const chunks: string[] = [];
      for await (const chunk of provider.stream("hi")) chunks.push(chunk.text);
    }).rejects.toBeInstanceOf(ProviderStatusError);
  });

  it("buildCloudProviders: no keys -> empty; both keys -> openai then anthropic", () => {
    expect(buildCloudProviders({})).toHaveLength(0);
    const both = buildCloudProviders({ OPENAI_API_KEY: "a", ANTHROPIC_API_KEY: "b" });
    expect(both.map((p) => p.provider)).toEqual(["openai", "anthropic"]);
  });

  it("buildCloudProviders: ATHENA_OPENAI_KEY takes precedence over OPENAI_API_KEY", () => {
    const providers = buildCloudProviders({ ATHENA_OPENAI_KEY: "primary", OPENAI_API_KEY: "fallback" });
    expect(providers).toHaveLength(1);
    expect(providers[0]?.provider).toBe("openai");
  });
});
