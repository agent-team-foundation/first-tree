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

/** Response when creating a member — includes the one-time plaintext password. */
export const memberCreatedSchema = memberSchema.extend({
  username: z.string(),
  displayName: z.string(),
  password: z.string(),
});
export type MemberCreated = z.infer<typeof memberCreatedSchema>;
