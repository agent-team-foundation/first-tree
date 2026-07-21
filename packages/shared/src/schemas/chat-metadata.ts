import { z } from "zod";

/**
 * `chats.metadata` is `jsonb` at the DB layer. Without a typed contract every
 * writer was free to invent their own keys, so writers could collide on
 * shared keys (`source`, `title`). The discriminated union below pins
 * writers to a single shape and lets TypeScript narrow on `metadata.source`.
 *
 * Add new variants here; do not extend with free-form `Record<string, unknown>`.
 */

/**
 * Source of truth for which github entity types the workspace UI knows
 * how to render. Drives `MeChatRow.entityType` (per-row sub-type, drives
 * the leading icon) and the `Github*Schema` discriminator below. The
 * `ChatSource` enum below does NOT branch on these — Phase C collapsed
 * the conversation-list origin filter to a single `github` value, and
 * the entity sub-type rides on `MeChatRow.entityType` instead. Adding a
 * new entry here means new icon mappings in
 * `packages/web/src/components/chat/source-icon.tsx`; the SQL classifier
 * does not need to be touched.
 */
export const GITHUB_ENTITY_TYPES = ["issue", "pull_request", "discussion", "commit"] as const;
export const githubEntityTypeSchema = z.enum(GITHUB_ENTITY_TYPES);
export type GithubEntityType = z.infer<typeof githubEntityTypeSchema>;

export const githubChatMetadataSchema = z.object({
  source: z.literal("github"),
  entityType: githubEntityTypeSchema,
  /** Stable cluster key, e.g. "owner/repo#42" or "owner/repo@<sha>". */
  entityKey: z.string().min(1),
  /** Optional canonical URL back to the GitHub entity (for UI deep-link). */
  entityUrl: z.string().url().optional(),
  /** True for Context Tree PR reviewer task chats created by GitHub App webhooks. */
  contextTreeReviewer: z.literal(true).optional(),
  /** Reviewer agent assigned when a Context Tree PR reviewer chat was created. */
  reviewerAgentUuid: z.string().min(1).optional(),
});
export type GithubChatMetadata = z.infer<typeof githubChatMetadataSchema>;

export const gitlabChatMetadataSchema = z.object({
  source: z.literal("gitlab"),
  entityType: z.enum(["issue", "pull_request"]),
  /** Stable numeric project/type/iid key emitted by the GitLab adapter. */
  entityKey: z.string().min(1),
  entityUrl: z.string().url().optional(),
  /** Stage 3 routes review requests; Stage 4 owns source-read execution state. */
  reviewRequestRouted: z.literal(true).optional(),
});
export type GitlabChatMetadata = z.infer<typeof gitlabChatMetadataSchema>;

export const agentChatMetadataSchema = z.object({
  source: z.literal("agent"),
  initiatedByAgentId: z.string().min(1).optional(),
  effectiveSenderReason: z.literal("self_target_manager_human").optional(),
});
export type AgentChatMetadata = z.infer<typeof agentChatMetadataSchema>;

/**
 * Discriminated union of typed chat-metadata shapes. Currently `github` is
 * joined by agent-created task chats; future writers should add new `source`
 * branches here instead of inventing untyped metadata keys.
 */
export const chatMetadataSchema = z.discriminatedUnion("source", [
  githubChatMetadataSchema,
  gitlabChatMetadataSchema,
  agentChatMetadataSchema,
]);
export type ChatMetadata = z.infer<typeof chatMetadataSchema>;

/**
 * `createChat` callers may not set metadata at all (admin-created group chats,
 * me-chats, …), so the input schema accepts either an empty object or one of
 * the typed variants. The empty `{}` arm is `.strict()` so a caller cannot
 * sneak through `{ source: "github" }` without the required fields.
 */
export const optionalChatMetadataSchema = z.union([z.object({}).strict(), chatMetadataSchema]);
export type OptionalChatMetadata = z.infer<typeof optionalChatMetadataSchema>;

/**
 * Chat creation callers may describe a GitHub entity, but only the server's
 * GitHub App webhook path may claim that a chat is a Context Reviewer chat.
 */
export const callerWritableChatMetadataSchema = z
  .record(z.string(), z.unknown())
  .superRefine((metadata, ctx) => {
    for (const key of ["contextTreeReviewer", "reviewerAgentUuid"] as const) {
      if (key in metadata) {
        ctx.addIssue({ code: "custom", message: `Chat metadata field '${key}' is server-owned.`, path: [key] });
      }
    }
  })
  .pipe(optionalChatMetadataSchema);
export type CallerWritableChatMetadata = z.infer<typeof callerWritableChatMetadataSchema>;

/**
 * Conversation-list origin tag. Coarse-grained "where does this chat come
 * from" classifier — one per integration, NOT per entity type within an
 * integration. GitHub PR / Issue / Discussion / Commit all collapse to
 * `github`; the per-entity granularity is preserved via the separate
 * `MeChatRow.entityType` field (so the row's leading icon can still
 * render a PR vs Issue glyph even though the filter popover only
 * exposes a single GitHub toggle).
 *
 *  - `manual` — user-created or any chat whose metadata is absent / empty /
 *    unrecognised. The default conversation-list
 *    view. Anything that doesn't cleanly match a known writer falls
 *    here so the default tab can't accidentally hide a chat.
 *  - `github` — projected from `{ source: "github", entityType: ... }`.
 *    Sub-type lives on `MeChatRow.entityType`.
 *  - `agent` — projected from `{ source: "agent", ... }`; used for task
 *    chats created by an agent/CLI/dispatcher workflow.
 *
 * The projection itself lives next to the WHERE clause that consumes
 * it (`packages/server/src/services/me-chat.ts::chatSourceSqlExpression`)
 * so the SQL CASE and any TS classifier stay textually adjacent to the
 * predicates they feed. Add a new variant on the metadata side first,
 * then extend this enum, then both the SQL CASE and the
 * `sourceFilterSql` switch.
 */
export const CHAT_SOURCES = ["manual", "github", "gitlab", "agent"] as const;
export const chatSourceSchema = z.enum(CHAT_SOURCES);
export type ChatSource = z.infer<typeof chatSourceSchema>;
