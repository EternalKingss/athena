export type L2Answer = {
  matched: boolean;
  text: string;
};

const RULES: Array<{ pattern: RegExp; text: string }> = [
  { pattern: /\b(status|doctor|health)\b/i, text: "Athena v4 kernel is online. Secure transport, event replay, and artifact checks are active." },
  { pattern: /\bhelp\b/i, text: "I can inspect files, classify command risk, recall memory, and route debugging turns through local or cloud providers." },
  { pattern: /\boffline\b/i, text: "Offline mode is supported. Recall falls back to BM25 and deterministic L2 answers stay available." },
];

export function answerWithL2(prompt: string): L2Answer {
  const rule = RULES.find((candidate) => candidate.pattern.test(prompt));
  return rule === undefined ? { matched: false, text: "" } : { matched: true, text: rule.text };
}
