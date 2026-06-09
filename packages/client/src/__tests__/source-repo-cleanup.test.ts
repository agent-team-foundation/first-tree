// Unit tests for helpers in `runtime/source-repo-cleanup.ts`. The companion
// integration tests for the state-based reconcile loop live in
// `source-repos-state-reconcile.test.ts`; this file pins the smaller
// classification helpers that drive that loop's branches.

import { describe, expect, it } from "vitest";
import { isFinalRemoveOutcome, type RemoveCloneOutcome } from "../runtime/source-repo-cleanup.js";

/**
 * Exhaustive snapshot of every variant in `RemoveCloneOutcome`. Listed
 * inline so a new union member added in source without a matching entry
 * here trips a TypeScript error at the `satisfies` line — the test then
 * fails to compile, forcing the author to decide whether the new outcome
 * is final or retry-eligible. This is the "防御未来给 union 加成员忘了
 * 分类" anchor (PR #913 code-reviewer follow-up nit 3).
 */
const OUTCOME_EXPECTATIONS = {
  removed: true,
  absent: true,
  "not-a-clone": true,
  "in-use-by-live-chat": false,
  dirty: false,
  "ahead-of-upstream": false,
  "has-worktrees": false,
  "probe-failed": false,
  "remove-failed": false,
} as const satisfies Record<RemoveCloneOutcome, boolean>;

describe("isFinalRemoveOutcome — full RemoveCloneOutcome enumeration", () => {
  for (const [outcome, expected] of Object.entries(OUTCOME_EXPECTATIONS) as ReadonlyArray<
    [RemoveCloneOutcome, boolean]
  >) {
    it(`${outcome} → ${expected ? "final (drop from managed state)" : "retry-eligible (keep in managed state)"}`, () => {
      expect(isFinalRemoveOutcome(outcome)).toBe(expected);
    });
  }

  it("exactly 3 outcomes are final", () => {
    const finalCount = Object.values(OUTCOME_EXPECTATIONS).filter(Boolean).length;
    expect(finalCount).toBe(3);
  });

  it("exactly 6 outcomes are retry-eligible", () => {
    const retryCount = Object.values(OUTCOME_EXPECTATIONS).filter((v) => !v).length;
    expect(retryCount).toBe(6);
  });
});
