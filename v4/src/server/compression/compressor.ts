export type MessageLike = {
  role: "user" | "assistant" | "tool";
  body: string;
};

export function compressWindow(messages: MessageLike[], windowSize = 40): string {
  const window = messages.slice(-windowSize);
  return window
    .map((message) => {
      const body = message.body.length > 400 ? `${message.body.slice(0, 397)}...` : message.body;
      return `[${message.role}] ${body}`;
    })
    .join("\n");
}
