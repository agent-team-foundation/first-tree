import { z } from "zod";

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type Login = z.infer<typeof loginSchema>;

export const loginResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshToken = z.infer<typeof refreshTokenSchema>;

export const connectTokenExchangeSchema = z.object({
  token: z.string().min(1),
});
export type ConnectTokenExchange = z.infer<typeof connectTokenExchangeSchema>;

export const connectTokenResponseSchema = z.object({
  token: z.string(),
  expiresIn: z.number(),
  command: z.string(),
});
export type ConnectTokenResponse = z.infer<typeof connectTokenResponseSchema>;

/**
 * Outcome of a successful sign-in: tokens plus a hint about where the user
 * should go next. The frontend uses `nextRoute` to decide between `/setup`
 * (no workspaces yet), `/welcome` (in-progress wizard), or `/` (regular).
 *
 * `accessToken` is either a `type: "user"` token (no `organizationId` claim,
 * scoped to `/me/workspaces*` + `/auth/switch-org` only) or a `type: "access"`
 * token (full per-org JWT). The frontend doesn't decode either — it just
 * follows `nextRoute` and re-authenticates after `switch-org` if needed.
 */
export const signInResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  /** "/setup" (no workspaces) | "/welcome" (wizard) | "/" (regular) | "/invite/<token>" (deep-link). */
  nextRoute: z.string(),
});
export type SignInResponse = z.infer<typeof signInResponseSchema>;

export const switchOrganizationRequestSchema = z.object({
  organizationId: z.string().min(1),
});
export type SwitchOrganizationRequest = z.infer<typeof switchOrganizationRequestSchema>;

/** Public preview of the workspace behind an invite token (landing page). */
export const invitePreviewSchema = z.object({
  organizationId: z.string(),
  organizationDisplayName: z.string(),
  organizationSlug: z.string(),
});
export type InvitePreview = z.infer<typeof invitePreviewSchema>;

/** Body for `POST /api/v1/me/workspaces` (creator path). */
export const createWorkspaceRequestSchema = z.object({
  /** URL-friendly slug. Same constraints as `organizations.name`. */
  name: z
    .string()
    .min(2)
    .max(50)
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "Must start with a letter or digit and contain only lowercase alphanumeric and hyphens",
    ),
  displayName: z.string().min(1).max(200),
});
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequestSchema>;

/** Body for `POST /api/v1/me/workspaces/join` (invitee path). */
export const joinWorkspaceRequestSchema = z.object({
  /**
   * Either a bare invite token or a full `https://hub/invite/<token>` URL —
   * the server tolerates both so the user can paste straight from chat.
   */
  tokenOrUrl: z.string().min(1),
});
export type JoinWorkspaceRequest = z.infer<typeof joinWorkspaceRequestSchema>;

/** Item in `GET /api/v1/me/workspaces`. */
export const workspaceListItemSchema = z.object({
  organizationId: z.string(),
  organizationName: z.string(),
  organizationDisplayName: z.string(),
  memberId: z.string(),
  role: z.enum(["admin", "member"]),
});
export type WorkspaceListItem = z.infer<typeof workspaceListItemSchema>;
