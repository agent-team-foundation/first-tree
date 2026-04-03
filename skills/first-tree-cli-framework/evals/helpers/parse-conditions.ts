/**
 * Parse condition strings from env var format.
 *
 * Format: "baseline,cli-v0.0.3:aaa111,human-curated:ccc333"
 * Each entry is either "label" (no tree) or "label:tree_sha".
 */

import type { EvalCondition } from '#evals/helpers/types.js';

export function parseConditions(env: string): EvalCondition[] {
  return env.split(',').map(s => {
    const trimmed = s.trim();
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) {
      return { label: trimmed };
    }
    return {
      label: trimmed.slice(0, colonIdx),
      tree_sha: trimmed.slice(colonIdx + 1),
    };
  });
}
