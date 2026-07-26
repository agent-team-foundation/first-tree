import type { GithubEntityType } from "@first-tree/shared";
import { formatScmAutoTopic, refreshScmAutoTopic } from "../../services/scm-entity-chat-topic.js";

/**
 * GitHub entity model — the unit of clustering for webhook → chat routing.
 * Two events share a chat iff their (type, key) match (or are linked via
 * `Fixes #N`). See docs/webhook-routing-design.md §4.2.
 */
export type GithubEntity = {
  type: GithubEntityType;
  /** Stable string id, e.g. `"owner/repo#42"` or `"owner/repo@<sha>"`. */
  key: string;
  /** Human label, e.g. `"Refactor inbox dispatcher"`. Optional — falls back to key. */
  title?: string;
  /** Canonical URL back to the GitHub UI. */
  url?: string;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pull `repository.full_name` ("owner/repo") from a webhook payload, or null. */
function repoFullName(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const repo = isRecord(payload.repository) ? payload.repository : null;
  return typeof repo?.full_name === "string" && repo.full_name.length > 0 ? repo.full_name : null;
}

export function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Resolve the entity that a GitHub webhook event belongs to.
 *
 * Returns `null` when the event isn't a clustering candidate (event type
 * outside the §4.1 "core" list, malformed payload). Caller is expected to
 * skip such events.
 *
 * Notes
 * - `commit_comment` falls back to a `commit` entity keyed on `<repo>@<sha>`
 *   when no associated PR is in the payload — the design hedges on "optionally
 *   resolve to a PR", but doing so requires an extra GitHub API call which we
 *   defer to Phase 1+.
 */
export function extractEventEntity(eventType: string, payload: unknown): GithubEntity | null {
  if (!isRecord(payload)) return null;
  const repo = repoFullName(payload);
  if (!repo) return null;

  switch (eventType) {
    case "issues": {
      const issue = isRecord(payload.issue) ? payload.issue : null;
      const number = readNumber(issue?.number);
      if (number === null) return null;
      return {
        type: "issue",
        key: `${repo}#${number}`,
        title: readString(issue?.title) ?? undefined,
        url: readString(issue?.html_url) ?? undefined,
      };
    }
    case "issue_comment": {
      const issue = isRecord(payload.issue) ? payload.issue : null;
      const number = readNumber(issue?.number);
      if (number === null) return null;
      // GitHub delivers PR comments as `issue_comment` events with
      // `issue.pull_request` populated. Without this branch the comment
      // clusters into an Issue chat rather than the existing PR chat —
      // the long-standing "PR comment opens an Issue chat" bug.
      const prInfo = isRecord(issue?.pull_request) ? issue.pull_request : null;
      if (prInfo) {
        return {
          type: "pull_request",
          key: `${repo}#${number}`,
          title: readString(issue?.title) ?? undefined,
          url: readString(prInfo.html_url) ?? readString(issue?.html_url) ?? undefined,
        };
      }
      return {
        type: "issue",
        key: `${repo}#${number}`,
        title: readString(issue?.title) ?? undefined,
        url: readString(issue?.html_url) ?? undefined,
      };
    }
    case "pull_request":
    case "pull_request_review":
    case "pull_request_review_comment": {
      const pr = isRecord(payload.pull_request) ? payload.pull_request : null;
      const number = readNumber(pr?.number);
      if (number === null) return null;
      return {
        type: "pull_request",
        key: `${repo}#${number}`,
        title: readString(pr?.title) ?? undefined,
        url: readString(pr?.html_url) ?? undefined,
      };
    }
    case "discussion":
    case "discussion_comment": {
      const disc = isRecord(payload.discussion) ? payload.discussion : null;
      const number = readNumber(disc?.number);
      if (number === null) return null;
      return {
        type: "discussion",
        key: `${repo}#${number}`,
        title: readString(disc?.title) ?? undefined,
        url: readString(disc?.html_url) ?? undefined,
      };
    }
    case "commit_comment": {
      const comment = isRecord(payload.comment) ? payload.comment : null;
      const sha = readString(comment?.commit_id);
      if (!sha) return null;
      return {
        type: "commit",
        key: `${repo}@${sha}`,
        url: readString(comment?.html_url) ?? undefined,
      };
    }
    default:
      return null;
  }
}

/**
 * Closing-keyword regex from
 * https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue
 * — `close[sd]? | fix(es|ed)? | resolve[sd]?`. Cross-repo `org/repo#N` is
 * deliberately excluded (out of scope for Phase 0; see §4.5).
 */
const FIXES_KEYWORDS_RE = /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+#(\d+)\b/gi;

/**
 * Parse `Fixes #N` / `Closes #N` / `Resolves #N` references out of a PR body.
 * Returns ordered, deduplicated entity references for issues in the same repo
 * (cross-repo refs ignored per §4.5).
 *
 * Caller is expected to pass `repoFullName` so we can build the entity key.
 */
export function parseFixesRefs(text: string | null | undefined, repoFullName: string): GithubEntity[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: GithubEntity[] = [];
  for (const match of text.matchAll(FIXES_KEYWORDS_RE)) {
    const num = match[1];
    if (!num) continue;
    const key = `${repoFullName}#${num}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: "issue", key });
  }
  return out;
}

/**
 * Pick a chat-title prefix from (entity, eventType, action).
 *
 * PR review-flow events (`pull_request.review_requested`,
 * `pull_request_review.*`, `pull_request_review_comment.*`) collapse into a
 * single "PR Review" prefix so a chat first-touched by a review event is
 * visibly distinct from one first-touched by `pull_request.opened`. Everything
 * else just renders the entity type.
 *
 * Note: chat titles are written once at chat creation (see
 * `github-entity-chat.ts::createEntityChat`) — subsequent events for the same
 * entity reuse the existing title even if their (event, action) maps to a
 * different prefix. This matches the "entity is the container" semantic.
 */
function entityTitlePrefix(entity: GithubEntity, eventType: string, action: string): string {
  if (eventType === "pull_request" && action === "review_requested") return "PR Review";
  if (eventType === "pull_request_review") return "PR Review";
  if (eventType === "pull_request_review_comment") return "PR Review";
  return baseTypePrefix(entity.type);
}

/**
 * Prefix derived purely from the entity type, with no review-flow
 * special-casing. Used both as the fallback inside `entityTitlePrefix` and to
 * enumerate the legal title heads when refreshing a topic (see
 * `refreshEntityTitle`).
 */
function baseTypePrefix(type: GithubEntity["type"]): string {
  switch (type) {
    case "issue":
      return "Issue";
    case "pull_request":
      return "PR";
    case "discussion":
      return "Discussion";
    case "commit":
      return "Commit";
  }
}

/**
 * Strip the leading `owner/` segment from an entity key so the chat title
 * stays compact. `owner/repo#42` → `repo#42`; `owner/repo@abc1234` →
 * `repo@abc1234`. The full `owner/repo#N` form is still used as the
 * clustering primary key (`github_entity_chat_mappings.entity_key`); only the
 * display string is shortened.
 */
function shortEntityKey(key: string): string {
  const slash = key.indexOf("/");
  return slash === -1 ? key : key.slice(slash + 1);
}

/**
 * Render a chat topic from an entity. Used as the chat title; kept short so
 * the chat-list row doesn't truncate aggressively.
 *
 *   formatEntityTitle({ type: "pull_request", key: "owner/repo#307", title: "Improve overview" }, "pull_request", "opened")
 *     → "PR repo#307: Improve overview"
 *   formatEntityTitle(<same>, "pull_request", "review_requested")
 *     → "PR Review repo#307: Improve overview"
 */
export function formatEntityTitle(entity: GithubEntity, eventType: string, action: string): string {
  const prefix = entityTitlePrefix(entity, eventType, action);
  const head = `${prefix} ${shortEntityKey(entity.key)}`;
  return formatScmAutoTopic(head, entity.title);
}

/**
 * Recompute a github chat topic when the upstream entity title changes, while
 * *preserving* the original prefix + anchor head. The prefix ("PR" vs
 * "PR Review", "Issue", …) is decided once at chat creation from the
 * first-touch event and must NOT drift when a later event with a different
 * `(eventType, action)` arrives — so we reuse the head already baked into the
 * stored topic rather than re-deriving it from this event.
 *
 * Returns the new topic, or `null` when `storedTopic` is not a recognised
 * github-format title for `entity` (e.g. an agent renamed the chat off-spec,
 * or the payload carries no title). The caller leaves such topics untouched.
 *
 *   refreshEntityTitle("PR Review repo#307: old", { type: "pull_request", key: "o/repo#307", title: "new" })
 *     → "PR Review repo#307: new"
 *   refreshEntityTitle("my custom name", <pr>) → null
 */
export function refreshEntityTitle(storedTopic: string, entity: GithubEntity): string | null {
  if (!entity.title || entity.title.length === 0) return null;
  const shortKey = shortEntityKey(entity.key);
  // For a PR the original head could be either the plain "PR" prefix or the
  // review-flow "PR Review" prefix; every other type has a single legal head.
  const heads =
    entity.type === "pull_request"
      ? [`PR Review ${shortKey}`, `PR ${shortKey}`]
      : [`${baseTypePrefix(entity.type)} ${shortKey}`];
  // Discussion chats minted before the key canonicalisation carry the
  // legacy `repo#discussion-N` head in their stored topic. Accept it so
  // those chats' titles keep refreshing — and rewrite to the canonical
  // head below so the topic converges with the backfilled mapping key.
  const legacyHeads =
    entity.type === "discussion"
      ? [`${baseTypePrefix(entity.type)} ${shortKey.replace(/#(\d+)$/, "#discussion-$1")}`]
      : [];
  // Longest first so "PR Review repo#7" is matched before "PR repo#7".
  return refreshScmAutoTopic(
    storedTopic,
    entity.title,
    [...heads, ...legacyHeads]
      .sort((a, b) => b.length - a.length)
      .map((head) => ({
        matches: head,
        nextHead: legacyHeads.includes(head) ? (heads[0] ?? head) : head,
      })),
  );
}
