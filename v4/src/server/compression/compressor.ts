export type MessageLike = {
  role: "user" | "assistant" | "tool";
  body: string;
};

const MAX_BODY = 400;
const SIGNAL = /\b(error|err|fail|failed|failure|exception|warn|warning|fatal|panic|denied|refused|timeout|traceback)\b/i;

export function compressWindow(messages: MessageLike[], windowSize = 40): string {
  const window = messages.slice(-windowSize);
  return window.map((message) => `[${message.role}] ${summarizeBody(message.body, message.role)}`).join("\n");
}

/**
 * SEMANTICS: tool results are *summarized* into compressed context, not dropped.
 * Short bodies pass through. Long bodies keep head + tail; tool output additionally
 * keeps signal lines (errors/warnings/stack frames) and records how much was elided,
 * so nothing disappears silently.
 */
export function summarizeBody(body: string, role: MessageLike["role"]): string {
  if (body.length <= MAX_BODY) return body;

  if (role === "tool") {
    const lines = body.split(/\r?\n/);
    const head = lines.slice(0, 3);
    const signal = lines.filter((line) => SIGNAL.test(line)).slice(0, 8);
    const tail = lines.slice(-3);
    const kept = unique([...head, ...signal, ...tail]).filter((line) => line.length > 0);
    const keptText = clip(kept.join("\n"), 1200);
    const elided = Math.max(0, body.length - keptText.length);
    return elided > 0 ? `${keptText}\n…[summarized: ~${elided} chars across ${lines.length} lines elided]` : keptText;
  }

  const headChars = MAX_BODY - 80;
  const elided = body.length - headChars - 40;
  return `${body.slice(0, headChars)}\n…[summarized: ${elided} chars elided]…\n${body.slice(-40)}`;
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
