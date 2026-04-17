/**
 * TS port of `classify.rs`.
 *
 * `TaskKind` classifies a GitHub notification subject + reason into the
 * breeze task taxonomy. `priority_for` returns the dispatcher priority;
 * `should_process_reason` gates which notification reasons get a task.
 *
 * Pure. No I/O. Safe to import from anywhere.
 */

export type TaskKind =
  | "review_request"
  | "mention"
  | "comment"
  | "assigned_issue"
  | "assigned_pull_request"
  | "discussion"
  | "other";

export const ALL_TASK_KINDS: readonly TaskKind[] = [
  "review_request",
  "mention",
  "comment",
  "assigned_issue",
  "assigned_pull_request",
  "discussion",
  "other",
];

export function taskKindFromString(value: string): TaskKind | undefined {
  return (ALL_TASK_KINDS as readonly string[]).includes(value)
    ? (value as TaskKind)
    : undefined;
}

/**
 * Whitelist of notification `reason`s that merit dispatch. Mirrors
 * `should_process_reason` in Rust — anything outside this list is
 * ignored (ci_activity, subscribed, state_change, etc.).
 */
export function shouldProcessReason(reason: string): boolean {
  switch (reason) {
    case "review_requested":
    case "comment":
    case "mention":
    case "team_mention":
    case "assign":
    case "author":
    case "manual":
      return true;
    default:
      return false;
  }
}

/** Dispatcher priority (higher wins). Mirrors `priority_for`. */
export function priorityFor(kind: TaskKind, reason: string): number {
  switch (kind) {
    case "review_request":
      return 100;
    case "mention":
      return 95;
    case "discussion":
      return 90;
    case "comment":
      return 85;
    case "assigned_pull_request":
      return 80;
    case "assigned_issue":
      return 70;
    case "other":
      return reason === "review_requested" ? 100 : 50;
  }
}

/**
 * Map subject_type + reason to a TaskKind. Review_requested wins
 * ahead of subject type; Discussion wins ahead of generic comment.
 */
export function classifyNotification(
  subjectType: string,
  reason: string,
): TaskKind {
  if (reason === "review_requested") return "review_request";
  if (reason === "mention" || reason === "team_mention") return "mention";
  if (subjectType.includes("Discussion")) return "discussion";
  if (reason === "comment" || reason === "author" || reason === "manual") {
    return "comment";
  }
  if (reason === "assign") {
    return subjectType === "PullRequest"
      ? "assigned_pull_request"
      : "assigned_issue";
  }
  return "other";
}
