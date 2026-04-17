/**
 * Pure derivation of `breeze_status` from GitHub labels + PR/issue state.
 *
 * TS port of `compute_breeze_status` in
 * `fetcher.rs:353-368`.
 *
 * Spec: `docs/migration/03-status-state-machine.md` §2.
 *
 * Precedence (top wins, each branch cites the spec):
 *   1. labels contains `breeze:done`                     → "done"  (§2 rule 1)
 *   2. gh_state is "MERGED" or "CLOSED"                  → "done"  (§2 rule 2)
 *   3. labels contains `breeze:human`                    → "human" (§2 rule 3)
 *   4. labels contains `breeze:wip`                      → "wip"   (§2 rule 4)
 *   5. otherwise                                         → "new"   (§2 rule 5)
 *
 * Note: `breeze:new` is NOT part of the derivation — absence of all
 * `breeze:*` labels is the real "new" signal (spec §2, "important
 * subtleties"). The label exists only for human readability.
 *
 * No I/O. No subprocesses. This module is safe to import from anywhere.
 */

import type { BreezeStatus, GhState } from "./types.js";

export interface ClassifierInput {
  /** GitHub label slugs as observed on the PR/issue. */
  labels: readonly string[];
  /**
   * GraphQL `state` for PR/Issue subjects (uppercase, exact). `null` or
   * `undefined` for Discussion / Release / etc., where state is unknown.
   */
  ghState: GhState | null | undefined;
}

/**
 * Derive the breeze status. Pure function — input-only.
 */
export function classifyBreezeStatus(input: ClassifierInput): BreezeStatus {
  const has = (needle: string): boolean =>
    input.labels.some((label) => label === needle);

  // Spec §2 rule 1: `breeze:done` wins absolutely, even over open+wip etc.
  // Spec §9 edge case: "Item with both breeze:done and breeze:wip → still
  // resolves to done" (fetcher.rs:816-822 test).
  if (has("breeze:done")) {
    return "done";
  }

  // Spec §2 rule 2: GitHub closing/merging the item derives "done" without
  // needing any breeze label. Case-sensitive uppercase — the GraphQL state
  // enum is uppercase by spec (see spec §10 "Unverified / needs input").
  if (input.ghState === "MERGED" || input.ghState === "CLOSED") {
    return "done";
  }

  // Spec §2 rule 3: explicit "needs human" label.
  if (has("breeze:human")) {
    return "human";
  }

  // Spec §2 rule 4: explicit "work in progress" label.
  if (has("breeze:wip")) {
    return "wip";
  }

  // Spec §2 rule 5: default. Absence of breeze:* labels on an OPEN item
  // (or any unknown state: Discussion / Release) maps to "new".
  return "new";
}
