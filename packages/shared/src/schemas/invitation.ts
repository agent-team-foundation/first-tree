import { z } from "zod";

/**
 * Public preview returned for an invite link before the recipient signs in.
 * Surfaces just enough for the recipient to recognise the team they're
 * joining; intentionally omits anything internal (memberCount, member
 * emails, billing) so an attacker can't enumerate via leaked tokens.
 */
export const invitationPreviewSchema = z.object({
  organizationId: z.string(),
  organizationName: z.string(),
  organizationDisplayName: z.string(),
  role: z.string(),
});
export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;

/**
 * Admin-only view of the *current* active invitation for an org.
 * `inviteUrl` is built server-side off `server.publicUrl` so the operator
 * doesn't have to compose it manually.
 */
export const invitationViewSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  token: z.string(),
  inviteUrl: z.string(),
  role: z.string(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
});
export type InvitationView = z.infer<typeof invitationViewSchema>;

/** Body for joining via invite token. */
export const joinByInvitationSchema = z.object({
  token: z.string().min(1),
});
export type JoinByInvitation = z.infer<typeof joinByInvitationSchema>;

/** Admin: rotate the active invitation (revoke prior + issue new). No body. */
export const rotateInvitationSchema = z.object({}).optional();

// NOTE: An expiry-update schema/route was deliberately removed — v1 doesn't
// surface the expires_at column to the API (the column itself is kept on
// `invitations` so a future "auto-expire" feature is a route addition,
// not a schema change). See proposal §"invitations 设计要点".
