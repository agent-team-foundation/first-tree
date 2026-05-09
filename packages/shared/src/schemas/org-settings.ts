import { z } from "zod";

/**
 * Per-organization settings — schemas, namespaces, and the registry that
 * dispatches `(orgId, namespace)` lookups to the right validator.
 *
 * Each namespace has three schemas:
 *   - `storage` — what is persisted in `organization_settings.value`. For
 *     namespaces with secrets, the storage schema names the *cipher* field
 *     (e.g. `webhookSecretCipher`); plaintext never touches the row.
 *   - `input`   — what the admin API accepts in PUT bodies. For namespaces
 *     with secrets, `webhookSecret` is plaintext; the service layer
 *     encrypts it before merging into storage.
 *   - `output`  — what GET returns. Secrets are replaced by a boolean
 *     `…Configured` flag — plaintext is never echoed.
 *
 * Adding a new per-org config group:
 *   1. Define three schemas (storage / input / output).
 *   2. Add a key to `ORG_SETTINGS_NAMESPACES`.
 *   3. Done. No DB migration, no new API route.
 */

// Empty / whitespace-only strings on the input layer mean "no change is
// being requested" rather than "set this field to an empty value" — the
// service layer coerces them to `null` (which means *clear*) only on the
// explicit `null` form. Users who want to clear a field send `null`,
// users who pass `""` get a validation error from `min(1)` below.

// -- context_tree --

export const orgContextTreeStorageSchema = z.object({
  repo: z.string().url().optional(),
  branch: z.string().default("main"),
});

export const orgContextTreeInputSchema = z.object({
  /** Set / replace (must be a valid URL). `null` clears. `undefined` leaves unchanged. */
  repo: z.string().url().min(1).nullish(),
  /** Set / replace (non-empty). `null` clears (server falls back to "main"). `undefined` leaves unchanged. */
  branch: z.string().min(1).nullish(),
});

export const orgContextTreeOutputSchema = z.object({
  repo: z.string().optional(),
  branch: z.string().optional(),
});

// -- github_integration --

export const orgGithubIntegrationStorageSchema = z.object({
  /** AES-256-GCM ciphertext via crypto.ts.encryptValue. Plaintext is never persisted. */
  webhookSecretCipher: z.string().optional(),
});

export const orgGithubIntegrationInputSchema = z.object({
  /**
   * Plaintext webhook secret.
   *   non-empty string — set / replace
   *   `null`           — clear
   *   `undefined`      — leave unchanged
   * Empty strings are rejected so the panel can't accidentally lock the
   * webhook into a "configured but never-validates" state (#3).
   */
  webhookSecret: z.string().min(1).nullish(),
});

export const orgGithubIntegrationOutputSchema = z.object({
  webhookSecretConfigured: z.boolean(),
  /**
   * Hub-resolved webhook URL surfaced to the admin UI. Empty string when
   * `server.publicUrl` is unset on the Hub — UI must show a "contact your
   * site administrator" notice in that case rather than fall back to
   * `window.location.origin` (which fails behind reverse proxies).
   */
  webhookUrl: z.string(),
});

// -- source_repos --

export const orgSourceReposStorageSchema = z.object({
  repos: z
    .array(
      z.object({
        url: z.string().url(),
        defaultBranch: z.string().optional(),
      }),
    )
    .default([]),
});

export const orgSourceReposInputSchema = z.object({
  /**
   * Replace the full repo list. `undefined` leaves the existing list
   * unchanged. `[]` clears it. There is no per-entry input form yet —
   * onboarding writes the whole list each time, and the Team Settings
   * card removes by re-PUTting the surviving entries.
   *
   * `defaultBranch` is `min(1)` here on the input boundary — the storage
   * schema is wider so historical / backfilled rows with an empty
   * `defaultBranch` aren't rejected on read.
   */
  repos: z
    .array(
      z.object({
        url: z.string().url(),
        defaultBranch: z.string().min(1).optional(),
      }),
    )
    .optional(),
});

export const orgSourceReposOutputSchema = z.object({
  repos: z.array(
    z.object({
      url: z.string(),
      defaultBranch: z.string().optional(),
    }),
  ),
});

// -- registry --

/**
 * GET-side ACL per namespace.
 *   "admin"  — only org admins can read. Use when the masked output still
 *              leaks "configured / not-configured" booleans for secret
 *              fields, or any other admin-only signal.
 *   "member" — any active org member can read. Use for namespaces with no
 *              secret fields where members legitimately need the value
 *              (e.g. invitee Step 3 reads `context_tree.repo` to show the
 *              team's bound tree before joining; same for `source_repos`).
 *
 * Write-side (PUT / DELETE) is always admin-only — non-admins must not
 * mutate org-wide config regardless of namespace policy.
 */
export type OrgSettingReadPolicy = "admin" | "member";

export const ORG_SETTINGS_NAMESPACES = {
  context_tree: {
    storage: orgContextTreeStorageSchema,
    input: orgContextTreeInputSchema,
    output: orgContextTreeOutputSchema,
    readPolicy: "member",
  },
  github_integration: {
    storage: orgGithubIntegrationStorageSchema,
    input: orgGithubIntegrationInputSchema,
    output: orgGithubIntegrationOutputSchema,
    readPolicy: "admin",
  },
  source_repos: {
    storage: orgSourceReposStorageSchema,
    input: orgSourceReposInputSchema,
    output: orgSourceReposOutputSchema,
    readPolicy: "member",
  },
} as const satisfies Record<
  string,
  {
    storage: z.ZodTypeAny;
    input: z.ZodTypeAny;
    output: z.ZodTypeAny;
    readPolicy: OrgSettingReadPolicy;
  }
>;

export const ORG_SETTINGS_NAMESPACE_KEYS = Object.keys(ORG_SETTINGS_NAMESPACES) as ReadonlyArray<
  keyof typeof ORG_SETTINGS_NAMESPACES
>;

export type OrgSettingNamespace = keyof typeof ORG_SETTINGS_NAMESPACES;

export type OrgSettingStorage<K extends OrgSettingNamespace> = z.infer<(typeof ORG_SETTINGS_NAMESPACES)[K]["storage"]>;
export type OrgSettingInput<K extends OrgSettingNamespace> = z.infer<(typeof ORG_SETTINGS_NAMESPACES)[K]["input"]>;
export type OrgSettingOutput<K extends OrgSettingNamespace> = z.infer<(typeof ORG_SETTINGS_NAMESPACES)[K]["output"]>;

export type OrgContextTreeStorage = OrgSettingStorage<"context_tree">;
export type OrgContextTreeInput = OrgSettingInput<"context_tree">;
export type OrgContextTreeOutput = OrgSettingOutput<"context_tree">;

export type OrgGithubIntegrationStorage = OrgSettingStorage<"github_integration">;
export type OrgGithubIntegrationInput = OrgSettingInput<"github_integration">;
export type OrgGithubIntegrationOutput = OrgSettingOutput<"github_integration">;

export type OrgSourceReposStorage = OrgSettingStorage<"source_repos">;
export type OrgSourceReposInput = OrgSettingInput<"source_repos">;
export type OrgSourceReposOutput = OrgSettingOutput<"source_repos">;

export const orgSettingNamespaceSchema = z.enum(
  ORG_SETTINGS_NAMESPACE_KEYS as [OrgSettingNamespace, ...OrgSettingNamespace[]],
);

export function isOrgSettingNamespace(value: unknown): value is OrgSettingNamespace {
  return typeof value === "string" && (ORG_SETTINGS_NAMESPACE_KEYS as ReadonlyArray<string>).includes(value);
}
