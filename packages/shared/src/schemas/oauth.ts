import { z } from "zod";

/**
 * `GET /api/v1/auth/github/start` query — `next` is the post-login landing
 * path. It is validated again before signing the state JWT (see
 * `safe-redirect.ts`); the schema only enforces the syntactic upper bound
 * so over-long paths bounce with a Zod error rather than silently truncate.
 */
export const githubStartQuerySchema = z.object({
  next: z.string().max(256).optional(),
});
export type GithubStartQuery = z.infer<typeof githubStartQuerySchema>;

export const githubCallbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  /**
   * GitHub App installation ID. Present when the user landed in callback
   * via the install flow ("first install of the App by this user / org").
   * Returning users who already had the App installed get `code` + `state`
   * without `installation_id` — First Tree must tolerate both shapes.
   *
   * Numeric per GitHub but transported as a query-string field, so accept
   * a digit-only string and coerce in the route handler.
   */
  installation_id: z.string().regex(/^\d+$/).optional(),
  /**
   * GitHub may send `setup_action=install` (first-time install), `update`
   * (existing install reconfigured / re-visited), or `request` (the user
   * requested install but an org admin must approve). We don't branch on
   * it — `installation_id` is the actual signal — but we accept all three
   * shapes so otherwise-valid callbacks aren't rejected at the schema
   * gate (codex P2 follow-up).
   */
  setup_action: z.enum(["install", "update", "request"]).optional(),
});
export type GithubCallbackQuery = z.infer<typeof githubCallbackQuerySchema>;

/**
 * Dev-only callback to bypass the GitHub round-trip — sign in as a stub
 * Github user. Gated by NODE_ENV !== 'production'; production always 404s.
 *
 * The App-flow extension fields (`installationId`, `installationAccountType`,
 * `installationAccountLogin`, `installationAccountGithubId`) let the dev
 * flow simulate a GitHub App install in the same redirect — when present
 * they stub a `github_app_installations` row before the OAuth flow
 * completes, so the rest of the dev session can exercise the App-bound
 * code paths (Settings → Integrations panel, webhook routing) without a
 * real install. Missing → legacy OAuth-only dev flow.
 */
export const githubDevCallbackQuerySchema = z.object({
  /** Synthetic GitHub numeric id (acts as `auth_identities.identifier`). */
  githubId: z.string().min(1),
  /** GitHub login slug — used for the default org slug derivation. */
  login: z.string().min(1),
  email: z.string().email().optional(),
  displayName: z.string().optional(),
  next: z.string().max(256).optional(),
  /** Synthetic installation id. Required to trigger the App-flow dev bypass. */
  installationId: z.string().regex(/^\d+$/).optional(),
  /** "User" | "Organization". Defaults to "User" when an installationId is set. */
  installationAccountType: z.enum(["User", "Organization"]).optional(),
  /** Account login for the simulated install. Defaults to `login`. */
  installationAccountLogin: z.string().min(1).optional(),
  /** Account numeric id for the simulated install. Defaults to `githubId`. */
  installationAccountGithubId: z.string().regex(/^\d+$/).optional(),
});
export type GithubDevCallbackQuery = z.infer<typeof githubDevCallbackQuerySchema>;
