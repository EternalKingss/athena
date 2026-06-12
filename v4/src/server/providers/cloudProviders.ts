import type { ChatProvider } from "./router.js";
import { createAnthropicProvider } from "./anthropicProvider.js";
import { createOpenAIProvider } from "./openaiProvider.js";

/**
 * Builds the cloud `ChatProvider` list from environment configuration. Order
 * is the failover order `StreamingRouter` walks: OpenAI first (if
 * configured), then Anthropic. Returns an empty array when no cloud API keys
 * are set, in which case Athena relies on the local llama provider (if
 * `ATHENA_LLAMA_URL` is set) or deterministic L2 answers.
 *
 * Env vars:
 * - `ATHENA_OPENAI_KEY` or `OPENAI_API_KEY` (+ optional `ATHENA_OPENAI_MODEL`, default `gpt-4o-mini`)
 * - `ANTHROPIC_API_KEY` (+ optional `ATHENA_ANTHROPIC_MODEL`, default `claude-haiku-4-5-20251001`)
 */
export function buildCloudProviders(env: NodeJS.ProcessEnv = process.env): ChatProvider[] {
  const providers: ChatProvider[] = [];

  const openaiKey = env.ATHENA_OPENAI_KEY ?? env.OPENAI_API_KEY;
  if (openaiKey) {
    providers.push(
      createOpenAIProvider({
        apiKey: openaiKey,
        ...(env.ATHENA_OPENAI_MODEL === undefined ? {} : { model: env.ATHENA_OPENAI_MODEL }),
      }),
    );
  }

  const anthropicKey = env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    providers.push(
      createAnthropicProvider({
        apiKey: anthropicKey,
        ...(env.ATHENA_ANTHROPIC_MODEL === undefined ? {} : { model: env.ATHENA_ANTHROPIC_MODEL }),
      }),
    );
  }

  return providers;
}
