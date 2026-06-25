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

/**
 * Plain-language definition of the "Processed" figure, for a `title`/tooltip
 * anywhere a bare `Processed N` label is shown without its breakdown (e.g. the
 * Usage tab column header / stat tiles). Users reported "processed" was opaque:
 * it counts cache-read tokens, which routinely dwarf the non-cached input, so
 * the number looks inflated next to a provider bill. Spell out what it is — and
 * what it is NOT — at every surface.
 */
export const PROCESSED_TOKENS_HINT =
  "Processed = input + cached + output: every token the model read or wrote, including cache reads. Not a billing figure (cache reads bill far cheaper).";

/**
 * Tooltip for a usage figure. Written as an explicit equation so the meaning of
 * "Processed" is legible on hover rather than left as jargon:
 *   `Processed 400 = Input 100 + Cached 250 + Output 50 · Active 150 (input + output, excludes cached) · 2 usage events`
 */
export function formatTokenUsageTitle(usage: TokenUsageParts, opts: { turns?: number } = {}): string {
  const input = tokenPart(usage.inputTokens);
  const cached = tokenPart(usage.cachedInputTokens);
  const output = tokenPart(usage.outputTokens);
  const activeTokens = activeTokenCount(usage);
  const processedTokens = processedTokenCount(usage);
  const parts = [
    `Processed ${processedTokens.toLocaleString()} = Input ${input.toLocaleString()} + Cached ${cached.toLocaleString()} + Output ${output.toLocaleString()}`,
    `Active ${activeTokens.toLocaleString()} (input + output, excludes cached)`,
  ];
  if (opts.turns != null) parts.push(`${opts.turns.toLocaleString()} usage events`);
  return parts.join(" · ");
}
