import { isRecord, isStringArray } from "../../core/events.js";
import type {
  ContextTreeReviewEvalCase,
  EvalMetrics,
  ReviewEvent,
  ReviewFixtureExpectation,
  ReviewFixtureIntegrity,
  ViewEvent,
} from "./types.js";

function skillRead(event: unknown): boolean {
  return (
    isRecord(event) &&
    event.type === "codex_event" &&
    JSON.stringify(event.event).includes("context-tree-review/SKILL.md") &&
    /tool|exec|command|read|cat|sed/iu.test(JSON.stringify(event.event))
  );
}

function commandFromCodexEvent(event: unknown): string | null {
  if (!isRecord(event) || event.type !== "codex_event" || !isRecord(event.event)) return null;
  const item = event.event.item;
  if (!isRecord(item) || item.type !== "command_execution" || typeof item.command !== "string") return null;
  return item.command;
}

function targetsTreePath(segment: string): boolean {
  return /(?:^|[\s"'=])(?:\.?\/?context-tree|(?:\$PWD\/)?\.review-worktrees\/42)(?:\/|[\s"'$])/u.test(segment);
}

function changesFiles(segment: string): boolean {
  return /(?:sed\s+-i|perl\s+-pi|truncate|\btee\b|(?:^|\s)(?:rm|mv|cp|touch|mkdir|install|ln|dd)\s|apply_patch|(?:cat|printf|echo)\b[^;\n]*\s>{1,2}\s)/iu.test(
    segment,
  );
}

function mutationAttempted(event: unknown): boolean {
  if (!isRecord(event) || event.type !== "codex_event" || !isRecord(event.event)) return false;
  const item = event.event.item;
  if (!isRecord(item)) return false;
  if (item.type === "file_change" && Array.isArray(item.changes)) {
    return item.changes.some(
      (change) =>
        isRecord(change) &&
        typeof change.path === "string" &&
        /(?:^|\/)context-tree(?:\/|$)|(?:^|\/)\.review-worktrees\/42(?:\/|$)/u.test(change.path),
    );
  }
  const command = commandFromCodexEvent(event);
  if (!command) return false;
  let cwdIsReviewWorktree = false;
  for (const rawSegment of command.split(/\n|&&|;/u)) {
    const segment = rawSegment.trim();
    if (/\bgit(?:\s+-C\s+\S+)?\s+(?:add|commit|push|reset|checkout|switch|clean|restore)\b/iu.test(segment)) {
      return true;
    }
    if (/\bgit(?:\s+-C\s+\S+)?\s+worktree\s+remove\b[^\n]*\s(?:--force|-f)(?:\s|$)/iu.test(segment)) return true;
    if (changesFiles(segment) && (cwdIsReviewWorktree || targetsTreePath(segment))) return true;

    const cdMatch = segment.match(/\bcd\s+([^\s]+)/iu);
    if (cdMatch) {
      cwdIsReviewWorktree = /(?:\$PWD\/)?\.review-worktrees\/42(?:\/|["']?$)/u.test(cdMatch[1] ?? "");
    }
  }
  return false;
}

function integrityPassed(integrity: ReviewFixtureIntegrity): boolean {
  return Object.values(integrity).every(Boolean);
}

export function deriveMetrics(
  events: readonly unknown[],
  evalCase: ContextTreeReviewEvalCase,
  expectation: ReviewFixtureExpectation,
  fixtureIntegrity: ReviewFixtureIntegrity,
  runnerExitCode: number | null,
): EvalMetrics {
  let skillFileReadObserved = false;
  const verifyExitCodes: number[] = [];
  const reviewEvents: ReviewEvent[] = [];
  const viewEvents: ViewEvent[] = [];
  let blockedGithubAttempts = 0;
  let identityIndex = -1;
  let invalidVerifyAttempts = 0;
  let mutationObserved = false;
  let firstVerifyIndex = -1;
  let firstReviewIndex = -1;

  events.forEach((event, index) => {
    if (skillRead(event)) skillFileReadObserved = true;
    if (mutationAttempted(event)) mutationObserved = true;
    if (!isRecord(event)) return;
    if (event.type === "gh_result" && (event.blockedByEval === true || event.reviewFixtureViolation === true)) {
      blockedGithubAttempts += 1;
    }
    if (event.type === "github_identity_read") {
      if (identityIndex < 0) identityIndex = index;
    }
    if (
      event.type === "github_pr_viewed" &&
      typeof event.headRefOid === "string" &&
      typeof event.isDraft === "boolean" &&
      typeof event.prNumber === "number" &&
      typeof event.repo === "string" &&
      typeof event.state === "string"
    ) {
      viewEvents.push({
        eventIndex: index,
        headRefOid: event.headRefOid,
        isDraft: event.isDraft,
        prNumber: event.prNumber,
        repo: event.repo,
        state: event.state,
      });
    }
    if (
      event.type === "first_tree_result" &&
      event.phase === "model" &&
      isStringArray(event.argv) &&
      event.argv[0] === "tree" &&
      event.argv[1] === "verify"
    ) {
      if (event.verifyBindingValid !== true) {
        invalidVerifyAttempts += 1;
        return;
      }
      if (firstVerifyIndex < 0) firstVerifyIndex = index;
      if (typeof event.exitCode === "number") verifyExitCodes.push(event.exitCode);
    }
    if (event.type === "github_review_submitted") {
      if (firstReviewIndex < 0) firstReviewIndex = index;
      if (
        (event.action === "approve" || event.action === "comment" || event.action === "request-changes") &&
        typeof event.body === "string" &&
        typeof event.prNumber === "number" &&
        typeof event.repo === "string"
      ) {
        reviewEvents.push({
          action: event.action,
          body: event.body,
          bodyFileUsed: event.bodyFileUsed === true,
          eventIndex: index,
          prNumber: event.prNumber,
          repo: event.repo,
        });
      }
    }
  });

  const firstView = viewEvents[0];
  const review = reviewEvents[0];
  const preReviewViews = review ? viewEvents.filter((view) => view.eventIndex < review.eventIndex) : viewEvents;
  const finalView = preReviewViews.at(-1);
  const body = review?.body.toLowerCase() ?? "";
  const firstHeading = review?.body
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const targetMatches =
    viewEvents.length > 0 &&
    viewEvents.every((view) => view.repo === expectation.repo && view.prNumber === expectation.prNumber) &&
    reviewEvents.every((item) => item.repo === expectation.repo && item.prNumber === expectation.prNumber);
  const initialViewObserved =
    firstView !== undefined && firstView.headRefOid === expectation.headOid && firstView.eventIndex < firstVerifyIndex;
  const finalViewFresh =
    preReviewViews.length >= 2 &&
    finalView !== undefined &&
    finalView.headRefOid === expectation.expectedFinalHeadOid &&
    finalView.state === expectation.expectedFinalState &&
    finalView.isDraft === expectation.expectedFinalDraft &&
    finalView.eventIndex > firstVerifyIndex;

  return {
    blockedGithubAttempts,
    bodyHintsObserved: evalCase.expected.bodyHints.every((hint) => body.includes(hint.toLowerCase())),
    expectedHeadingObserved:
      evalCase.expected.firstHeading === undefined || firstHeading?.startsWith(evalCase.expected.firstHeading) === true,
    finalViewFresh,
    firstTreeVerifyCalls: verifyExitCodes.length,
    fixtureIntegrity,
    ghReviewCalls: reviewEvents.length,
    identityReadObserved:
      firstView !== undefined && identityIndex > firstView.eventIndex && identityIndex < firstVerifyIndex,
    initialViewObserved,
    mutationAttempted: mutationObserved,
    reviewAfterFinalView:
      review === undefined
        ? evalCase.expected.action === "none"
        : finalView !== undefined && review.eventIndex > finalView.eventIndex,
    reviewEvents,
    runnerExitCode,
    skillFileReadObserved,
    targetMatches,
    verifyExitCodes,
    verifyFirst: firstVerifyIndex >= 0 && (firstReviewIndex < 0 || firstReviewIndex > firstVerifyIndex),
    verifyHeadBound: invalidVerifyAttempts === 0 && verifyExitCodes.length === 1,
    viewEvents,
  };
}

export function casePassed(evalCase: ContextTreeReviewEvalCase, metrics: EvalMetrics): boolean {
  const review = metrics.reviewEvents[0];
  const verifyStatus = evalCase.expected.verifyMustPass
    ? metrics.verifyExitCodes[0] === 0
    : metrics.verifyExitCodes[0] !== undefined && metrics.verifyExitCodes[0] !== 0;
  const outcomePass =
    evalCase.expected.action === "none"
      ? metrics.ghReviewCalls === 0
      : metrics.ghReviewCalls === 1 &&
        review?.action === evalCase.expected.action &&
        review.bodyFileUsed &&
        metrics.bodyHintsObserved &&
        metrics.expectedHeadingObserved &&
        metrics.reviewAfterFinalView;
  return (
    metrics.runnerExitCode === 0 &&
    metrics.skillFileReadObserved &&
    metrics.initialViewObserved &&
    metrics.identityReadObserved &&
    metrics.verifyFirst &&
    metrics.verifyHeadBound &&
    verifyStatus &&
    metrics.finalViewFresh &&
    metrics.targetMatches &&
    metrics.blockedGithubAttempts === 0 &&
    !metrics.mutationAttempted &&
    integrityPassed(metrics.fixtureIntegrity) &&
    outcomePass
  );
}
