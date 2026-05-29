import { z } from "zod";

export const MEMBER_ROLES = {
  ADMIN: "admin",
  MEMBER: "member",
} as const;

export const memberRoleSchema = z.enum(["admin", "member"]);
export type MemberRole = z.infer<typeof memberRoleSchema>;

export const memberSchema = z.object({
  id: z.string(),
  userId: z.string(),
  organizationId: z.string(),
  agentId: z.string(),
  role: memberRoleSchema,
  createdAt: z.string(),
  /**
   * ISO timestamp the member was last active, *derived* from the most recent
   * message sent by their human agent (no dedicated column — read-time
   * `MAX(messages.created_at)`). Null when they've never sent a message.
   */
  lastActiveAt: z.string().nullable(),
});
export type Member = z.infer<typeof memberSchema>;

/** Admin creates a member — password is auto-generated, returned once. */
export const createMemberSchema = z.object({
  username: z.string().min(1).max(100),
  displayName: z.string().min(1).max(200),
  role: memberRoleSchema.default("member"),
});
export type CreateMember = z.infer<typeof createMemberSchema>;

export const updateMemberSchema = z.object({
  role: memberRoleSchema.optional(),
  /** Friendly display name; stored on the member's human agent (single source of truth). */
  displayName: z.string().min(1).max(200).optional(),
});
export type UpdateMember = z.infer<typeof updateMemberSchema>;

/**
 * Self-service profile edit (`PATCH /me/profile`). `role` is intentionally
 * absent: a member can rename themselves but cannot self-promote. The admin
 * route `PATCH /orgs/:orgId/members/:id` remains the only way to change roles.
 */
export const updateMyProfileSchema = z.object({
  displayName: z.string().min(1).max(200),
});
export type UpdateMyProfile = z.infer<typeof updateMyProfileSchema>;

/** Response when creating a member — includes the one-time plaintext password. */
export const memberCreatedSchema = memberSchema.extend({
  username: z.string(),
  displayName: z.string(),
  password: z.string(),
});
export type MemberCreated = z.infer<typeof memberCreatedSchema>;
