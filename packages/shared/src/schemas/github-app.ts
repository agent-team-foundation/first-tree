import { z } from "zod";

/**
 * GitHub App installation — schemas shared between server and web.
 *
 * Background: First Tree is migrating from a per-repo OAuth + webhook model to a
 * GitHub App installation model. Each First Tree team binds 1:1 to a single GitHub
 * account (User or Organization). The binding row lives in
 * `github_app_installations`; this file owns the public-facing Zod shapes
 * (account type, permissions, output DTO) so server and web agree on the
 * wire format without duplicating literals.
 *
 * See `docs/github-app-design-zh.md` (decisions D0a / D0b / D1 / D2 / D3 / D4)
 * for the rationale.
 */

/**
 * GitHub installation account kinds.
 *   - "User" — personal-account install. `members` sync is a no-op or
 *     only-owner; see design doc §6 risk 1.
 *   - "Organization" — org-account install. Eligible for full
 *     identity-convergence (Phase 4).
 *
 * Mirrors the `installation.account.type` field on GitHub webhook payloads.
 */
export const GITHUB_ACCOUNT_TYPES = ["User", "Organization"] as const;
export const githubAccountTypeSchema = z.enum(GITHUB_ACCOUNT_TYPES);
export type GithubAccountType = z.infer<typeof githubAccountTypeSchema>;

/**
 * Permission levels GitHub grants per resource.
 *   "read"  — pull permission only
 *   "write" — pull + push (write implies read in GitHub's model)
 *   "admin" — full administrative control (rarely required)
 *
 * Mirrors the value side of `installation.permissions` on webhook payloads.
 */
export const GITHUB_PERMISSION_LEVELS = ["read", "write", "admin"] as const;
export const githubPermissionLevelSchema = z.enum(GITHUB_PERMISSION_LEVELS);
export type GithubPermissionLevel = z.infer<typeof githubPermissionLevelSchema>;

/**
 * `installation.permissions` blob from GitHub. Key is the permission name
 * (`contents`, `pull_requests`, `issues`, `members`, …) — we keep this as a
 * free-form `z.record` because GitHub adds new permission keys over time
 * and we don't want a First Tree-side `app_id` upgrade just to surface a new key
 * in the integrations panel.
 */
export const githubAppInstallationPermissionsSchema = z.record(z.string(), githubPermissionLevelSchema);
export type GithubAppInstallationPermissions = z.infer<typeof githubAppInstallationPermissionsSchema>;

/**
 * Subscribed event-name list, e.g. `["issues", "pull_request", "push"]`.
 * Free-form for the same forward-compat reason as `permissions`.
 */
export const githubAppInstallationEventsSchema = z.array(z.string());
export type GithubAppInstallationEvents = z.infer<typeof githubAppInstallationEventsSchema>;

/**
 * `auth_identities.metadata` shape for GitHub App user-to-server tokens.
 *
 * Pre-App (legacy OAuth) rows have only `accessToken` (encrypted OAuth
 * token, never-expires). After the App switch:
 *   - `accessToken`        — encrypted user-to-server token, ~8h TTL
 *   - `accessTokenExpiresAt` — ISO-8601, used to decide pre-emptive refresh
 *   - `refreshToken`       — encrypted refresh token, ~6mo TTL
 *   - `refreshTokenExpiresAt` — ISO-8601; once past, force re-login
 *   - `login`              — GitHub login snapshot (already present pre-App)
 *
 * Rows may temporarily be in the legacy shape (no expiry fields) until the
 * user re-OAuths through the App. Service code MUST tolerate both shapes
 * and treat absence of expiry fields as "still on legacy OAuth token".
 *
 * The token strings themselves are AES-256-GCM ciphertext — same pattern as
 * `adapter_configs`. Plaintext never touches the row.
 */
export const githubAppUserTokenMetadataSchema = z.object({
  login: z.string().optional(),
  /** AES-256-GCM ciphertext via crypto.ts.encryptValue. */
  accessToken: z.string().optional(),
  /** ISO-8601. Absent on legacy non-App tokens. */
  accessTokenExpiresAt: z.string().datetime({ offset: true }).optional(),
  /** AES-256-GCM ciphertext via crypto.ts.encryptValue. */
  refreshToken: z.string().optional(),
  /** ISO-8601. Absent on legacy non-App tokens. */
  refreshTokenExpiresAt: z.string().datetime({ offset: true }).optional(),
});
export type GithubAppUserTokenMetadata = z.infer<typeof githubAppUserTokenMetadataSchema>;

/**
 * GET-side projection returned by the First Tree admin API for the Integrations
 * panel. Secrets are never echoed — only the metadata needed to render
 * "you're connected as @octocat (Organization), 7 repos selected".
 *
 * `selectedRepoCount` is derived from a separate join (App webhook
 * `installation_repositories` events update a children table not modeled
 * here yet); included now so the panel's API shape is stable from the
 * first ship.
 */
/**
 * Body for `POST /orgs/:orgId/github-app-installation/claim` — manual
 * recovery for an installation row that ended up unbound (codex P1-5 + H1).
 * The orphan-reclaim sweep at sign-in auto-claims the single-orphan case;
 * this endpoint backs the Settings "Claim install" buttons when there's
 * more than one (or the account is an org, where auto-claim is too risky).
 */
export const githubAppInstallationClaimBodySchema = z.object({
  installationId: z.number().int().positive(),
});
export type GithubAppInstallationClaimBody = z.infer<typeof githubAppInstallationClaimBodySchema>;

export const githubAppInstallationOutputSchema = z.object({
  installationId: z.number().int().positive(),
  accountType: githubAccountTypeSchema,
  accountLogin: z.string(),
  accountGithubId: z.number().int().positive(),
  permissions: githubAppInstallationPermissionsSchema,
  events: githubAppInstallationEventsSchema,
  suspended: z.boolean(),
  /**
   * GitHub-side management URL for this installation, e.g.
   * `https://github.com/settings/installations/123` (User) or
   * `https://github.com/organizations/<login>/settings/installations/123`
   * (Organization). Server resolves the right form by `accountType`.
   */
  manageUrl: z.string().url(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type GithubAppInstallationOutput = z.infer<typeof githubAppInstallationOutputSchema>;
