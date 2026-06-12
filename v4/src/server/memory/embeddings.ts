export type RecallProvider = {
  name: string;
  available: () => boolean;
  recall: (query: string, corpus: string[]) => string[];
};

export function recallCascade(query: string, corpus: string[], providers: RecallProvider[]): { provider: string; results: string[] } {
  for (const provider of providers) {
    if (!provider.available()) continue;
    const results = provider.recall(query, corpus);
    if (results.length > 0) return { provider: provider.name, results };
  }
  return { provider: "bm25", results: bm25Fallback(query, corpus) };
}

export function bm25Fallback(query: string, corpus: string[]): string[] {
  const queryTokens = new Set(query.toLowerCase().match(/[a-z0-9_]+/g) ?? []);
  return corpus
    .map((item) => ({
      item,
      score: [...queryTokens].filter((token) => item.toLowerCase().includes(token)).length,
    }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((row) => row.item);
}
