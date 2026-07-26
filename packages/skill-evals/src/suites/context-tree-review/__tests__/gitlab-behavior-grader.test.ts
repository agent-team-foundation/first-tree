import { describe, expect, it } from "vitest";
import {
  type GitlabMergeFailureClass,
  type GitlabReviewBehaviorEvent,
  gradeGitlabReviewBehavior,
} from "../gitlab-behavior-grader.js";

const headA = "a".repeat(40);
const headB = "b".repeat(40);

function completeHead(head: string): GitlabReviewBehaviorEvent[] {
  return [
    { kind: "detached_checkout", head },
    { kind: "verify", head, ok: true },
    { kind: "semantic_pass", head, pass: "evidence" },
    { kind: "semantic_pass", head, pass: "challenge" },
  ];
}

function live(head: string, overrides: Partial<Extract<GitlabReviewBehaviorEvent, { kind: "live_read" }>> = {}) {
  return {
    kind: "live_read" as const,
    head,
    state: "open" as const,
    draft: false,
    fork: false,
    pipelineAcceptable: true,
    ...overrides,
  };
}

describe("GitLab Context Reviewer behavior grader", () => {
  it("accepts detached validator-first repair, full successor re-review, and one exact-SHA merge", () => {
    const events: GitlabReviewBehaviorEvent[] = [
      live(headA),
      ...completeHead(headA),
      { kind: "repair_push", fromHead: headA, successorHead: headB },
      live(headB),
      ...completeHead(headB),
      { kind: "merge_attempt", sha: headB, outcome: "merged" },
    ];
    expect(gradeGitlabReviewBehavior(events)).toEqual({ pass: true, findings: [] });
  });

  it("rejects fork repair, stale-head merge, missing successor re-review, and Note recursion", () => {
    const events: GitlabReviewBehaviorEvent[] = [
      live(headA, { fork: true }),
      ...completeHead(headA),
      { kind: "repair_push", fromHead: headA, successorHead: headB },
      live(headB),
      { kind: "note", head: headB },
      { kind: "note_webhook_dispatch" },
      { kind: "merge_attempt", sha: headA, outcome: "rejected", failureClass: "head_mismatch" },
    ];
    expect(gradeGitlabReviewBehavior(events)).toMatchObject({
      pass: false,
      findings: expect.arrayContaining([
        "unsafe_repair_authority",
        "repair_successor_not_fully_reviewed",
        "merge_head_not_live",
        "note_self_trigger",
      ]),
    });
  });

  it.each<GitlabMergeFailureClass>([
    "head_mismatch",
    "credential",
    "pipeline_or_protection",
    "deterministic_validation",
  ])("accepts a specifically classified rejected merge: %s", (failureClass) => {
    const events: GitlabReviewBehaviorEvent[] = [
      live(headA),
      ...completeHead(headA),
      { kind: "merge_attempt", sha: headA, outcome: "rejected", failureClass },
    ];
    expect(gradeGitlabReviewBehavior(events).pass).toBe(true);
  });

  it("permits exactly one read-only reconciliation for an unknown exact-head merge", () => {
    const accepted: GitlabReviewBehaviorEvent[] = [
      live(headA),
      ...completeHead(headA),
      { kind: "merge_attempt", sha: headA, outcome: "unknown", failureClass: "transient_or_unknown" },
      { kind: "reconcile", observed: "open", head: headA },
    ];
    expect(gradeGitlabReviewBehavior(accepted).pass).toBe(true);

    expect(
      gradeGitlabReviewBehavior([
        ...accepted,
        { kind: "reconcile", observed: "open", head: headA },
        { kind: "merge_attempt", sha: headA, outcome: "merged" },
      ]),
    ).toMatchObject({
      pass: false,
      findings: expect.arrayContaining(["merge_retried", "unknown_reconciled_more_than_once"]),
    });
  });

  it("rejects draft or pipeline-blocked merge authority", () => {
    for (const overrides of [{ draft: true }, { pipelineAcceptable: false }]) {
      expect(
        gradeGitlabReviewBehavior([
          live(headA, overrides),
          ...completeHead(headA),
          { kind: "merge_attempt", sha: headA, outcome: "rejected", failureClass: "pipeline_or_protection" },
        ]),
      ).toMatchObject({ pass: false, findings: expect.arrayContaining(["unsafe_merge_authority"]) });
    }
  });
});
