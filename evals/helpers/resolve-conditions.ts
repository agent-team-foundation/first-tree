/**
 * Resolve eval conditions for a given case.
 *
 * Priority: EVALS_CONDITIONS env var > case-embedded context_tree_versions > baseline.
 */

import type { EvalCase, EvalCondition } from './types.js';
import { parseConditions } from './parse-conditions.js';

export function resolveConditions(evalCase: EvalCase): EvalCondition[] {
  if (process.env.EVALS_CONDITIONS) {
    return parseConditions(process.env.EVALS_CONDITIONS);
  }
  if (evalCase.context_tree_versions?.length) {
    return [
      { label: 'baseline' },
      ...evalCase.context_tree_versions.map(v => ({
        label: v.label,
        tree_sha: v.tree_sha,
      })),
    ];
  }
  return [{ label: 'baseline' }];
}
