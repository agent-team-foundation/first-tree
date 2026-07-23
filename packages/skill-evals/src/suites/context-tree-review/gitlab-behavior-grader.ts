import { isRecord, isStringArray } from "../../core/events.js";
import type { EvalMetrics, ReviewFixtureExpectation } from "./types.js";

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
 * Translate the real eval trace into provider behavior events. Semantic passes
 * are admitted only when the generic trace grader observed all governed reads
 * after the matching validator run; they are not inferred from prompt text.
 */
export function deriveGitlabReviewBehavior(
  rawEvents: readonly unknown[],
  metrics: EvalMetrics,
  expectation: ReviewFixtureExpectation,
): GitlabReviewBehaviorEvent[] {
  const events: GitlabReviewBehaviorEvent[] = [];
  for (const event of rawEvents) {
    if (!isRecord(event)) continue;
    if (
      event.type === "gitlab_mr_viewed" &&
      typeof event.headRefOid === "string" &&
      typeof event.state === "string" &&
      typeof event.isDraft === "boolean"
    ) {
      events.push({
        kind: "live_read",
        head: event.headRefOid,
        state: event.state === "MERGED" ? "merged" : event.state === "CLOSED" ? "closed" : "open",
        draft: event.isDraft,
        fork: event.fork === true,
        pipelineAcceptable: event.pipelineAcceptable === true,
      });
      continue;
    }
    if (event.type === "gitlab_detached_checkout" && typeof event.head === "string") {
      events.push({ kind: "detached_checkout", head: event.head });
      continue;
    }
    if (
      event.type === "first_tree_result" &&
      event.phase === "model" &&
      isStringArray(event.argv) &&
      event.argv[0] === "tree" &&
      event.argv[1] === "verify" &&
      event.verifyBindingValid === true &&
      typeof event.actualHead === "string" &&
      typeof event.exitCode === "number"
    ) {
      events.push({ kind: "verify", head: event.actualHead, ok: event.exitCode === 0 });
      const completeInitial =
        event.reviewVerifyKind === "initial-review" && event.exitCode === 0 && metrics.semanticReadAfterVerify;
      const completeSuccessor =
        event.reviewVerifyKind === "successor-review" &&
        event.exitCode === 0 &&
        metrics.successorSemanticReviewComplete;
      if (completeInitial || completeSuccessor) {
        events.push(
          { kind: "semantic_pass", head: event.actualHead, pass: "evidence" },
          { kind: "semantic_pass", head: event.actualHead, pass: "challenge" },
        );
      }
      continue;
    }
    if (
      event.type === "context_review_repair_pushed" &&
      typeof event.fromHead === "string" &&
      typeof event.successorHead === "string"
    ) {
      events.push({ kind: "repair_push", fromHead: event.fromHead, successorHead: event.successorHead });
      continue;
    }
    if (event.type === "gitlab_mr_noted" && typeof event.head === "string") {
      events.push({ kind: "note", head: event.head });
      continue;
    }
    if (
      event.type === "gitlab_merge_attempt" &&
      typeof event.sha === "string" &&
      (event.outcome === "merged" || event.outcome === "rejected" || event.outcome === "unknown")
    ) {
      events.push({
        kind: "merge_attempt",
        sha: event.sha,
        outcome: event.outcome,
        ...(isMergeFailureClass(event.failureClass) ? { failureClass: event.failureClass } : {}),
      });
      continue;
    }
    if (
      event.type === "gitlab_merge_reconciled" &&
      (event.observed === "merged" || event.observed === "open" || event.observed === "unknown")
    ) {
      events.push({
        kind: "reconcile",
        observed: event.observed,
        head: typeof event.head === "string" ? event.head : null,
      });
    }
  }

  // The fixture identity is part of the derivation boundary: ignore events
  // from a different provider even if a malformed trace contains them.
  return expectation.forgeProvider === "gitlab" ? events : [];
}

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

function isMergeFailureClass(value: unknown): value is GitlabMergeFailureClass {
  return (
    value === "head_mismatch" ||
    value === "credential" ||
    value === "pipeline_or_protection" ||
    value === "deterministic_validation" ||
    value === "transient_or_unknown"
  );
}
