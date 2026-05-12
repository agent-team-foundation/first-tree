import { z } from "zod";

/**
 * `chats.metadata` is `jsonb` at the DB layer. Without a typed contract every
 * writer was free to invent their own keys, so a GitHub webhook writing
 * `{ source: "github", entityKey: "..." }` and a Feishu adapter writing
 * `{ source: "feishu", externalChannelId: "..." }` could collide on shared
 * keys (`source`, `title`). The discriminated union below pins both writers
 * to a single shape and lets TypeScript narrow on `metadata.source`.
 *
 * Add new variants here; do not extend with free-form `Record<string, unknown>`.
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
});
export type GithubChatMetadata = z.infer<typeof githubChatMetadataSchema>;

export const feishuChatMetadataSchema = z.object({
  source: z.literal("feishu"),
  externalChannelId: z.string().min(1),
});
export type FeishuChatMetadata = z.infer<typeof feishuChatMetadataSchema>;

export const chatMetadataSchema = z.discriminatedUnion("source", [githubChatMetadataSchema, feishuChatMetadataSchema]);
export type ChatMetadata = z.infer<typeof chatMetadataSchema>;

/**
 * `createChat` callers may not set metadata at all (admin-created group chats,
 * me-chats, …), so the input schema accepts either an empty object or one of
 * the typed variants. The empty `{}` arm is `.strict()` so a caller cannot
 * sneak through `{ source: "github" }` without the required fields.
 */
export const optionalChatMetadataSchema = z.union([z.object({}).strict(), chatMetadataSchema]);
export type OptionalChatMetadata = z.infer<typeof optionalChatMetadataSchema>;
