import { z } from "zod";
import { githubEntityTypeSchema } from "./chat-metadata.js";

/**
 * Schema for `GET /api/v1/chats/:chatId/github-entities`.
 *
 * Each item describes one entity bound to the chat via
 * `github_entity_chat_mappings`. The server projects state from the
 * webhook-synced `entity_state` column rather than calling GitHub on the
 * read path.
 *
 * Title may be `null` because mapping rows do not persist titles. The client
 * falls back to rendering `entityKey + htmlUrl` so the row is still a
 * working link.
 */

/**
 * How a mapping row came to exist. `agent_declared` / `human_declared` are
 * written by the explicit `github follow` paths (agent route / user route);
 * there is no implicit agent-side wiring — creating a PR or Issue never
 * follows it.
 *
 * Legacy `agent_created` rows from the retired session-event auto-binder were
 * backfilled into `agent_declared` by a data-only migration. The preprocess
 * below additionally normalises the value at READ time — belt-and-suspenders
 * for any row written by a still-draining old instance after the one-shot
 * backfill ran (rolling deploy window). Without it such a row would fail the
 * enum parse and silently vanish from every listing.
 */
export const githubEntityBoundViaSchema = z.preprocess(
  (value) => (value === "agent_created" ? "agent_declared" : value),
  z.enum(["direct", "fixes_link", "human_fallback", "agent_declared", "human_declared"]),
);
export type GithubEntityBoundVia = z.infer<typeof githubEntityBoundViaSchema>;

/**
 * The subset of `bound_via` values written by an explicit follow. Exported as
 * the single definition of "deliberately declared" so consumers (e.g. the
 * `pull_request.opened` audience carve-out) can't drift when a new declared
 * flavour is added.
 */
export const DECLARED_BOUND_VIA = ["agent_declared", "human_declared"] as const;
export type DeclaredBoundVia = (typeof DECLARED_BOUND_VIA)[number];
export function isDeclaredBoundVia(value: string): value is DeclaredBoundVia {
  return (DECLARED_BOUND_VIA as readonly string[]).includes(value);
}

/**
 * Coarse entity state. PR-specific values (`merged`, `draft`) are folded
 * into the same enum as the issue's `open` / `closed` so the UI can
 * switch on a single field. `null` means the state is not meaningful for
 * this entity type, or the persisted value was unknown.
 */
export const githubEntityLiveStateSchema = z.enum(["open", "closed", "merged", "draft"]);
export type GithubEntityLiveState = z.infer<typeof githubEntityLiveStateSchema>;

export const chatGithubEntitySchema = z.object({
  entityType: githubEntityTypeSchema,
  /** Stable cluster key, e.g. "owner/repo#42". */
  entityKey: z.string().min(1),
  /** How the binding was first created — audit-only, surfaced by the UI as a small caption. */
  boundVia: githubEntityBoundViaSchema,
  /**
   * Canonical GitHub URL derived purely from `entityKey` + `entityType`.
   * Always present so the row remains a working link even when GitHub is
   * unreachable for the live fields.
   */
  htmlUrl: z.string().url(),
  /** Persisted title projection when available; currently null for mapping-only rows. */
  title: z.string().nullable(),
  /** Webhook-synced state projection. `null` for discussions. */
  state: githubEntityLiveStateSchema.nullable(),
  /** Issue / PR / Discussion number when applicable. */
  number: z.number().int().nullable(),
});
export type ChatGithubEntity = z.infer<typeof chatGithubEntitySchema>;

export const chatGithubEntityListResponseSchema = z.object({
  items: z.array(chatGithubEntitySchema),
});
export type ChatGithubEntityListResponse = z.infer<typeof chatGithubEntityListResponseSchema>;

/**
 * Request body for `POST .../chats/:chatId/github-entities` (follow).
 *
 * `entity` accepts a full GitHub URL (`https://github.com/o/r/pull/42`),
 * the short numeric form (`owner/repo#42` — issue vs PR resolved against
 * the GitHub API, with discussion fallback).
 *
 * `rebind: true` MOVES the binding into the target chat when the same
 * (human, delegate) line already lives in another chat — the 409 outcome's
 * explicit override. It never duplicates the line.
 */
export const followGithubEntityRequestSchema = z.object({
  entity: z.string().min(1).max(512),
  rebind: z.boolean().optional().default(false),
});
export type FollowGithubEntityRequest = z.infer<typeof followGithubEntityRequestSchema>;

/**
 * Success body for follow. Wire status codes carry the distinction too
 * (`201` created / rebound, `200` already_following); the field exists so
 * CLI/JSON consumers don't have to reverse-map status codes.
 */
export const followGithubEntityResponseSchema = z.object({
  status: z.enum(["created", "already_following", "rebound"]),
  entity: chatGithubEntitySchema,
});
export type FollowGithubEntityResponse = z.infer<typeof followGithubEntityResponseSchema>;

/**
 * `409` body for follow: the same (human, delegate) line for this entity
 * already lives in another chat. Carries enough context for the caller to
 * decide between working in that chat and `rebind`-ing the line here.
 */
export const followGithubEntityConflictSchema = z.object({
  error: z.literal("ENTITY_FOLLOWED_ELSEWHERE"),
  message: z.string(),
  conflict: z.object({
    chatId: z.string().min(1),
    topic: z.string().nullable(),
  }),
});
export type FollowGithubEntityConflict = z.infer<typeof followGithubEntityConflictSchema>;

/**
 * Body for `DELETE .../chats/:chatId/github-entities?entity=...` (unfollow).
 * Always `200` — DELETE is idempotent by design; `removed: 0` means the chat
 * wasn't following (terminal success, not an error). `removed > 1` happens
 * when several (human, delegate) lines pointed at this chat (e.g.
 * `fixes_link` / `human_fallback` siblings) — unfollow severs them all.
 */
export const unfollowGithubEntityResponseSchema = z.object({
  removed: z.number().int().min(0),
});
export type UnfollowGithubEntityResponse = z.infer<typeof unfollowGithubEntityResponseSchema>;
