import { z } from "zod";

export const MEMBER_ROLES = {
  ADMIN: "admin",
  MEMBER: "member",
} as const;

export const memberRoleSchema = z.enum(["admin", "member"]);
export type MemberRole = z.infer<typeof memberRoleSchema>;

export const ONBOARDING_STEPS = {
  CONNECT: "connect",
  CREATE_AGENT: "create_agent",
  COMPLETED: "completed",
} as const;

export const onboardingStepSchema = z.enum(["connect", "create_agent", "completed"]);
export type OnboardingStep = z.infer<typeof onboardingStepSchema>;

/**
 * Wizard checkpoint, one per (user × workspace). Null on legacy rows and on
 * fresh memberships before the wizard begins. See P0-5 in
 * docs/saas-onboarding-journey.md §6.1.
 */
export const onboardingStateSchema = z.object({
  currentStep: onboardingStepSchema,
});
export type OnboardingState = z.infer<typeof onboardingStateSchema>;

export const memberSchema = z.object({
  id: z.string(),
  userId: z.string(),
  organizationId: z.string(),
  agentId: z.string(),
  role: memberRoleSchema,
  /**
   * Wizard checkpoint. `.nullish()` because existing service projections
   * (`listMembers`, `getMember`) do not yet select this column — PR #5
   * adds the projection alongside the wizard-completion writes. Once that
   * lands, tighten to `.nullable()`.
   */
  onboardingState: onboardingStateSchema.nullish(),
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
