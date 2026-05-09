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

const sourceRepoEntrySchema = z.object({
  url: z.string().url(),
  defaultBranch: z.string().min(1).optional(),
});

export const orgSourceReposStorageSchema = z.object({
  repos: z.array(sourceRepoEntrySchema).default([]),
});

export const orgSourceReposInputSchema = z.object({
  /**
   * Replace the full repo list. `undefined` leaves the existing list
   * unchanged. `[]` clears it. There is no per-entry input form yet —
   * onboarding writes the whole list each time, and the Team Settings
   * card removes by re-PUTting the surviving entries.
   */
  repos: z.array(sourceRepoEntrySchema).optional(),
});

export const orgSourceReposOutputSchema = z.object({
  repos: z.array(sourceRepoEntrySchema),
});

// -- registry --

export const ORG_SETTINGS_NAMESPACES = {
  context_tree: {
    storage: orgContextTreeStorageSchema,
    input: orgContextTreeInputSchema,
    output: orgContextTreeOutputSchema,
  },
  github_integration: {
    storage: orgGithubIntegrationStorageSchema,
    input: orgGithubIntegrationInputSchema,
    output: orgGithubIntegrationOutputSchema,
  },
  source_repos: {
    storage: orgSourceReposStorageSchema,
    input: orgSourceReposInputSchema,
    output: orgSourceReposOutputSchema,
  },
} as const;

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
