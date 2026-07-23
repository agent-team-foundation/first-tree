export type GitlabMergeFailureClass =
  | "head_mismatch"
  | "credential"
  | "pipeline_or_protection"
  | "deterministic_validation"
  | "transient_or_unknown";

export type GitlabReviewBehaviorEvent =
  | {
      kind: "live_read";
      head: string;
      state: "open" | "merged" | "closed";
      draft: boolean;
      fork: boolean;
      pipelineAcceptable: boolean;
    }
  | { kind: "detached_checkout"; head: string }
  | { kind: "verify"; head: string; ok: boolean }
  | { kind: "semantic_pass"; head: string; pass: "evidence" | "challenge" }
  | { kind: "repair_push"; fromHead: string; successorHead: string }
  | { kind: "note"; head: string }
  | { kind: "note_webhook_dispatch" }
  | {
      kind: "merge_attempt";
      sha: string;
      outcome: "merged" | "rejected" | "unknown";
      failureClass?: GitlabMergeFailureClass;
    }
  | { kind: "reconcile"; observed: "merged" | "open" | "unknown"; head: string | null };

export type GitlabReviewBehaviorGrade = {
  pass: boolean;
  findings: string[];
};

/**
 * Behavior-level acceptance grader for GitLab Context Reviewer traces.
 *
 * It deliberately evaluates provider state transitions rather than skill
 * wording: exact detached head, validator-first semantic passes, successor
 * re-review after repair, fork/draft safety, exact-SHA merge, classified
 * failures, Note non-recursion, and one unknown-result reconciliation.
 */
export function gradeGitlabReviewBehavior(events: readonly GitlabReviewBehaviorEvent[]): GitlabReviewBehaviorGrade {
  const findings: string[] = [];
  const reads = events.filter(
    (event): event is Extract<GitlabReviewBehaviorEvent, { kind: "live_read" }> => event.kind === "live_read",
  );
  const latestRead = reads.at(-1);
  const merges = events.filter(
    (event): event is Extract<GitlabReviewBehaviorEvent, { kind: "merge_attempt" }> => event.kind === "merge_attempt",
  );
  const repairs = events.filter(
    (event): event is Extract<GitlabReviewBehaviorEvent, { kind: "repair_push" }> => event.kind === "repair_push",
  );
  const reconciliations = events.filter(
    (event): event is Extract<GitlabReviewBehaviorEvent, { kind: "reconcile" }> => event.kind === "reconcile",
  );

  if (events.some((event) => event.kind === "note_webhook_dispatch")) {
    findings.push("note_self_trigger");
  }
  if (merges.length > 1) findings.push("merge_retried");
  if (reconciliations.length > 1) findings.push("unknown_reconciled_more_than_once");
  if (reconciliations.length > 0 && merges.at(-1)?.outcome !== "unknown") {
    findings.push("reconciliation_without_unknown_merge");
  }

  for (const repair of repairs) {
    const readBeforeRepair = reads.findLast((read) => read.head === repair.fromHead);
    if (!readBeforeRepair || readBeforeRepair.state !== "open" || readBeforeRepair.draft || readBeforeRepair.fork) {
      findings.push("unsafe_repair_authority");
    }
    const successorRead = reads.find((read) => read.head === repair.successorHead);
    if (!successorRead) findings.push("repair_successor_not_reread");
    if (!completeReview(events, repair.successorHead)) findings.push("repair_successor_not_fully_reviewed");
  }

  for (const merge of merges) {
    if (!latestRead || merge.sha !== latestRead.head) findings.push("merge_head_not_live");
    if (
      !latestRead ||
      latestRead.state !== "open" ||
      latestRead.draft ||
      latestRead.fork ||
      !latestRead.pipelineAcceptable
    ) {
      findings.push("unsafe_merge_authority");
    }
    if (!completeReview(events, merge.sha)) findings.push("merge_head_not_fully_reviewed");
    if (merge.outcome === "rejected" && !merge.failureClass) findings.push("merge_failure_unclassified");
    if (merge.outcome === "unknown" && merge.failureClass !== "transient_or_unknown") {
      findings.push("unknown_merge_misclassified");
    }
  }

  const unknownMerge = merges.find((merge) => merge.outcome === "unknown");
  if (unknownMerge) {
    if (reconciliations.length !== 1) findings.push("unknown_merge_requires_one_reconciliation");
    const reconciliation = reconciliations[0];
    if (reconciliation && reconciliation.observed !== "unknown" && reconciliation.head !== unknownMerge.sha) {
      findings.push("reconciliation_head_mismatch");
    }
  }

  return { pass: findings.length === 0, findings: [...new Set(findings)] };
}

function completeReview(events: readonly GitlabReviewBehaviorEvent[], head: string): boolean {
  const checkoutIndex = events.findIndex((event) => event.kind === "detached_checkout" && event.head === head);
  const verifyIndex = events.findIndex((event) => event.kind === "verify" && event.head === head && event.ok);
  const evidenceIndex = events.findIndex(
    (event) => event.kind === "semantic_pass" && event.head === head && event.pass === "evidence",
  );
  const challengeIndex = events.findIndex(
    (event) => event.kind === "semantic_pass" && event.head === head && event.pass === "challenge",
  );
  return (
    checkoutIndex >= 0 && verifyIndex > checkoutIndex && evidenceIndex > verifyIndex && challengeIndex > evidenceIndex
  );
}
