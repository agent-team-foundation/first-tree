import { z } from "zod";
import { githubEntityTypeSchema } from "./chat-metadata.js";

/**
 * Schema for `GET /api/v1/chats/:chatId/github-entities`.
 *
 * Each item describes one entity bound to the chat via
 * `github_entity_chat_mappings`. Live state (`title`, `state`) is fetched
 * per-request from the GitHub REST API at request time and NEVER
 * persisted to the database — the user explicitly opted for the
 * fresh-on-every-open model rather than a webhook-synced column.
 *
 * Live fields may be `null` when the GitHub call failed (token unavailable,
 * rate-limited, 404 on a deleted entity, etc.). The client falls back to
 * rendering `entityKey + htmlUrl` so the row is still a working link.
 */

export const githubEntityBoundViaSchema = z.enum(["direct", "fixes_link", "agent_created"]);
export type GithubEntityBoundVia = z.infer<typeof githubEntityBoundViaSchema>;

/**
 * Coarse live state. PR-specific values (`merged`, `draft`) are folded
 * into the same enum as the issue's `open` / `closed` so the UI can
 * switch on a single field. `null` means we couldn't reach GitHub for
 * this entity in this request — the row still renders, just without
 * the state badge.
 */
export const githubEntityLiveStateSchema = z.enum(["open", "closed", "merged", "draft"]);
export type GithubEntityLiveState = z.infer<typeof githubEntityLiveStateSchema>;

export const chatGithubEntitySchema = z.object({
  entityType: githubEntityTypeSchema,
  /** Stable cluster key, e.g. "owner/repo#42" or "owner/repo@<sha>". */
  entityKey: z.string().min(1),
  /** How the binding was first created — audit-only, surfaced by the UI as a small caption. */
  boundVia: githubEntityBoundViaSchema,
  /**
   * Canonical GitHub URL derived purely from `entityKey` + `entityType`.
   * Always present so the row remains a working link even when GitHub is
   * unreachable for the live fields.
   */
  htmlUrl: z.string().url(),
  /** Live title from GitHub. `null` when the fetch failed / no token. */
  title: z.string().nullable(),
  /** Live state from GitHub. `null` when the fetch failed / no token. */
  state: githubEntityLiveStateSchema.nullable(),
  /** Issue / PR / Discussion number when applicable. */
  number: z.number().int().nullable(),
});
export type ChatGithubEntity = z.infer<typeof chatGithubEntitySchema>;

export const chatGithubEntityListResponseSchema = z.object({
  items: z.array(chatGithubEntitySchema),
});
export type ChatGithubEntityListResponse = z.infer<typeof chatGithubEntityListResponseSchema>;
