export type TokenUsageParts = {
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
};

function tokenPart(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function activeTokenCount(usage: TokenUsageParts): number {
  return tokenPart(usage.inputTokens) + tokenPart(usage.outputTokens);
}

export function processedTokenCount(usage: TokenUsageParts): number {
  return activeTokenCount(usage) + tokenPart(usage.cachedInputTokens);
}

export function formatTokenUsageTitle(usage: TokenUsageParts, opts: { turns?: number } = {}): string {
  const activeTokens = activeTokenCount(usage);
  const processedTokens = processedTokenCount(usage);
  const parts = [
    `Processed ${processedTokens.toLocaleString()}`,
    `Active ${activeTokens.toLocaleString()}`,
    `Input ${tokenPart(usage.inputTokens).toLocaleString()}`,
    `Cached ${tokenPart(usage.cachedInputTokens).toLocaleString()}`,
    `Output ${tokenPart(usage.outputTokens).toLocaleString()}`,
  ];
  if (opts.turns != null) parts.push(`${opts.turns.toLocaleString()} usage events`);
  return parts.join(" · ");
}
