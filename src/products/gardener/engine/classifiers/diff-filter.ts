/**
 * Shared noise filter for PR diffs fed to classifiers.
 *
 * A PR that regenerates `pnpm-lock.yaml` or ships minified build output
 * can blow past the classifier's byte cap before any real-code hunk
 * reaches the model. Filter those files out of the diff BEFORE applying
 * the cap, so the cap bounds real code instead of noise.
 *
 * Regex list originated in `src/products/tree/engine/sync.ts` (the
 * `DIFF_NOISE_PATTERNS` constant used by `formatPrDiffForPrompt`) —
 * extracted here so sync and both classifiers share one source of truth.
 */

export const DIFF_NOISE_PATTERNS: readonly RegExp[] = [
  /(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|Gemfile\.lock)$/,
  /(^|\/)(?:dist|build|out|coverage|node_modules|__pycache__)\//,
  /\.(?:lock|min\.js|min\.css|map|snap)$/,
];

/** True when `filename` matches any noise pattern. */
export function isDiffNoise(filename: string): boolean {
  return DIFF_NOISE_PATTERNS.some((re) => re.test(filename));
}

/**
 * Strip noise-file hunks from a unified-diff text. The input is the raw
 * output of `gh pr diff` (or equivalent) — a concatenation of per-file
 * hunks each starting with `diff --git a/<path> b/<path>`.
 *
 * The parser is deliberately simple: it splits on the `diff --git`
 * marker, extracts the `b/<path>` target filename from each hunk header,
 * and drops the whole hunk if that path is noise. Anything before the
 * first `diff --git` marker (rare — usually empty) is preserved as-is.
 *
 * Malformed hunks that don't yield a parseable filename are kept by
 * default: we'd rather show too much than silently drop a real change.
 */
export function filterDiffNoise(diff: string): string {
  if (diff === "") return diff;

  // Split keeping the delimiter at the start of each segment. The first
  // segment is anything before the first `diff --git` (usually empty).
  const parts = diff.split(/(?=^diff --git )/m);
  const kept: string[] = [];
  for (const part of parts) {
    if (!part.startsWith("diff --git ")) {
      if (part.length > 0) kept.push(part);
      continue;
    }
    const header = part.slice(0, part.indexOf("\n"));
    // `diff --git a/<path> b/<path>` — pull the b-side path.
    const match = header.match(/^diff --git a\/.+ b\/(.+)$/);
    const filename = match?.[1]?.trim();
    if (filename && isDiffNoise(filename)) continue;
    kept.push(part);
  }
  return kept.join("");
}
