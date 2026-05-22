/**
 * Pure derivation of `github_scan_status` from GitHub labels + PR/issue state.
 *
 * TS port of `compute_github_scan_status` in
 * `fetcher.rs:353-368`.
 *
 * Spec: the status state-machine spec (historical migration doc, now removed; see git history) §2.
 *
 * Precedence (top wins, each branch cites the spec):
 *   1. labels contains `github-scan:done`                     → "done"  (§2 rule 1)
 *   2. gh_state is "MERGED" or "CLOSED"                  → "done"  (§2 rule 2)
 *   3. labels contains `github-scan:human`                    → "human" (§2 rule 3)
 *   4. labels contains `github-scan:wip`                      → "wip"   (§2 rule 4)
 *   5. otherwise                                         → "new"   (§2 rule 5)
 *
 * Note: `github-scan:new` is NOT part of the derivation — absence of all
 * `github-scan:*` labels is the real "new" signal (spec §2, "important
 * subtleties"). The label exists only for human readability.
 *
 * No I/O. No subprocesses. This module is safe to import from anywhere.
 */

import type { GitHubScanStatus, GhState } from "./types.js";

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
 * Derive the github-scan status. Pure function — input-only.
 */
export function classifyGitHubScanStatus(input: ClassifierInput): GitHubScanStatus {
  const has = (needle: string): boolean =>
    input.labels.some((label) => label === needle);

  // Spec §2 rule 1: `github-scan:done` wins absolutely, even over open+wip etc.
  // Spec §9 edge case: "Item with both github-scan:done and github-scan:wip → still
  // resolves to done" (fetcher.rs:816-822 test).
  if (has("github-scan:done")) {
    return "done";
  }

  // Spec §2 rule 2: GitHub closing/merging the item derives "done" without
  // needing any github-scan label. Case-sensitive uppercase — the GraphQL state
  // enum is uppercase by spec (see spec §10 "Unverified / needs input").
  if (input.ghState === "MERGED" || input.ghState === "CLOSED") {
    return "done";
  }

  // Spec §2 rule 3: explicit "needs human" label.
  if (has("github-scan:human")) {
    return "human";
  }

  // Spec §2 rule 4: explicit "work in progress" label.
  if (has("github-scan:wip")) {
    return "wip";
  }

  // Spec §2 rule 5: default. Absence of github-scan:* labels on an OPEN item
  // (or any unknown state: Discussion / Release) maps to "new".
  return "new";
}
