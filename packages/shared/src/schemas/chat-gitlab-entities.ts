import { z } from "zod";
import { scmEntityStateSchema } from "./normalized-event.js";

export const chatGitlabEntityTypeSchema = z.enum(["issue", "pull_request"]);
export type ChatGitlabEntityType = z.infer<typeof chatGitlabEntityTypeSchema>;

export const chatGitlabEntityBoundViaSchema = z.enum(["agent_declared", "human_declared", "identity_target"]);
export type ChatGitlabEntityBoundVia = z.infer<typeof chatGitlabEntityBoundViaSchema>;

export const chatGitlabEntityStatusSchema = z.enum(["pending", "active"]);
export type ChatGitlabEntityStatus = z.infer<typeof chatGitlabEntityStatusSchema>;

/**
 * Public projection of one GitLab entity-to-chat binding.
 *
 * This intentionally excludes mapping, connection, organization, actor, and
 * normalized-path identifiers. The projection includes explicit declarations
 * and automatic `identity_target` bindings created by personnel routing.
 * `status` is derived from whether webhook ingress has resolved the numeric
 * GitLab project identity.
 */
export const chatGitlabEntitySchema = z.object({
  entityType: chatGitlabEntityTypeSchema,
  entityUrl: z.string().url(),
  projectPath: z.string().min(1),
  entityIid: z.number().int().positive(),
  title: z.string().nullable(),
  state: scmEntityStateSchema.nullable(),
  status: chatGitlabEntityStatusSchema,
  boundVia: chatGitlabEntityBoundViaSchema,
});
export type ChatGitlabEntity = z.infer<typeof chatGitlabEntitySchema>;

export const chatGitlabEntityListResponseSchema = z.object({
  items: z.array(chatGitlabEntitySchema),
});
export type ChatGitlabEntityListResponse = z.infer<typeof chatGitlabEntityListResponseSchema>;

/** Agent/CLI follow contract. The server resolves the Team's current connection. */
export const followChatGitlabEntityRequestSchema = z
  .object({
    entityUrl: z.string().url().max(2048),
    rebind: z.boolean().default(false),
  })
  .strict();
export type FollowChatGitlabEntityRequest = z.input<typeof followChatGitlabEntityRequestSchema>;

export const followChatGitlabEntityResponseSchema = z.object({
  status: z.enum(["created", "already_following", "rebound"]),
  entity: chatGitlabEntitySchema,
});
export type FollowChatGitlabEntityResponse = z.infer<typeof followChatGitlabEntityResponseSchema>;

export const followChatGitlabEntityConflictSchema = z.object({
  error: z.literal("ENTITY_FOLLOWED_ELSEWHERE"),
  message: z.string().min(1),
  conflict: z.object({
    chatId: z.string().min(1),
    topic: z.string().nullable(),
  }),
});
export type FollowChatGitlabEntityConflict = z.infer<typeof followChatGitlabEntityConflictSchema>;

export const unfollowChatGitlabEntityResponseSchema = z.object({
  removed: z.number().int().min(0),
});
export type UnfollowChatGitlabEntityResponse = z.infer<typeof unfollowChatGitlabEntityResponseSchema>;
