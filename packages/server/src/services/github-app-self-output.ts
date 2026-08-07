import { GITHUB_TASK_REPLY_RUN_MARKER_PREFIX } from "@first-tree/shared";
import { isRecord, readString } from "../api/webhooks/github-entity.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function normalizeGithubAppLogin(login: string): string {
  return login
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/u, "");
}

/** Whether a GitHub login denotes the configured First Tree App, with or without the `[bot]` suffix. */
export function isGithubAppTargetLogin(login: string, appSlug: string | null | undefined): boolean {
  if (!appSlug?.trim()) return false;
  return normalizeGithubAppLogin(login) === normalizeGithubAppLogin(appSlug);
}

/**
 * The configured App acting as itself: the App login AND GitHub's own `Bot`
 * account type. Requiring both keeps a human account that merely borrowed the
 * slug as a display name from inheriting App authority.
 */
function isConfiguredAppBot(
  login: string | null,
  accountType: string | null,
  appSlug: string | null | undefined,
): boolean {
  if (!login || !appSlug || accountType?.trim().toLowerCase() !== "bot") return false;
  const normalizedSlug = normalizeGithubAppLogin(appSlug);
  return normalizedSlug.length > 0 && login.trim().toLowerCase() === `${normalizedSlug}[bot]`;
}

export function hasValidGithubTaskReplyRunMarker(body: string): boolean {
  let markerIndex = body.indexOf(GITHUB_TASK_REPLY_RUN_MARKER_PREFIX);
  while (markerIndex >= 0) {
    const runIdStart = markerIndex + GITHUB_TASK_REPLY_RUN_MARKER_PREFIX.length;
    const markerEnd = body.indexOf(" -->", runIdStart);
    if (markerEnd >= 0 && UUID_PATTERN.test(body.slice(runIdStart, markerEnd))) {
      return true;
    }
    markerIndex = body.indexOf(GITHUB_TASK_REPLY_RUN_MARKER_PREFIX, runIdStart);
  }
  return false;
}

export type GithubAppSelfOutputInput = {
  appSlug: string | null | undefined;
  eventType: string;
  action: string | null;
  payload: unknown;
};

/**
 * Canonical anti-loop boundary: does this webhook report a terminal reply that
 * First Tree itself published for an existing task run?
 *
 * Both proofs are required: the comment author must be the configured App's
 * GitHub `Bot` identity AND the body must carry a valid server-authored run
 * marker. App-authored events without that marker are ordinary external input;
 * suppressing them would silently discard work merely because the App happened
 * to be the actor.
 *
 * Self-output still fans out as an ordinary subscription card. It only loses
 * provider-task authority, which prevents a published terminal reply from
 * minting a second run and recursively answering itself.
 */
export function isGithubAppSelfOutput(input: GithubAppSelfOutputInput): boolean {
  if (!input.appSlug?.trim() || !isRecord(input.payload)) return false;
  return isAppAuthoredTaskReplyComment(input.payload, input.eventType, input.action, input.appSlug);
}

function isAppAuthoredTaskReplyComment(
  payload: Record<string, unknown>,
  eventType: string,
  action: string | null,
  appSlug: string | null | undefined,
): boolean {
  if (eventType !== "issue_comment" || (action !== "created" && action !== "edited")) return false;
  const comment = isRecord(payload.comment) ? payload.comment : null;
  const author = comment && isRecord(comment.user) ? comment.user : null;
  if (!author || !isConfiguredAppBot(readString(author.login), readString(author.type), appSlug)) return false;
  return typeof comment?.body === "string" && hasValidGithubTaskReplyRunMarker(comment.body);
}
