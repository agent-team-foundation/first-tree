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

// Shared URL schema for repo URLs persisted in per-org settings. Accepts
// three forms — all three end up cloned by user agents, and the client's
// fallback layer (see `git-mirror-manager.ts`) transparently swaps between
// HTTPS and SSH when one direction's credentials are missing on a given
// machine. Used by both `context_tree.repo` and `source_repos[].url`.
//
//   1. `https://host[:port]/path[.git]`
//   2. `ssh://[user@]host[:port]/path[.git]`         (URL form)
//   3. `[user@]host:path[.git]`                      (scp-like, the form
//                                                     `git clone` uses by
//                                                     default for SSH)
//
// Hazards we still reject:
//   - `http://`  — plaintext, MITM-able
//   - `git://`   — unauthenticated, no integrity
//   - any URL with embedded credentials (`https://user:pass@host/...` or
//     `ssh://user:pass@host/...`) — those leak secrets into logs and API
//     responses; ssh URLs may legitimately carry a username (`git@`) but
//     never a password.

// scp-like SSH: `[user@]host:path` where:
//   - host is a non-empty hostname (letters/digits/`.`/`-`/`_`), no `/`, no
//     port (port can't be expressed in scp form — use ssh:// for that)
//   - path is non-empty, not all-digits (all-digits means git would
//     interpret `host:1234` as a port → ambiguous, force ssh:// form),
//     forbids `:` and `@` (already consumed by the earlier captures), and
//     can't start with `/` (legal scp paths start with the first repo path
//     segment, e.g. `owner/repo.git`)
const SCP_LIKE_SSH_RE = /^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9.-]+:(?!\d+(?:\/|$))[^/:@\s][^:@\s]*$/;

function isScpLikeSshUrl(value: string): boolean {
  // Belt-and-braces guard: anything containing `://` is a URL form, not
  // scp. Without this, `http://host/path` would superficially fit the regex
  // (host=`http`, path=`//host/path`) and bypass the protocol checks.
  if (value.includes("://")) return false;
  return SCP_LIKE_SSH_RE.test(value);
}

export const repoUrlSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    // scp-like form — not a parseable URL; validated by regex above.
    if (isScpLikeSshUrl(value)) {
      // No further checks: scp-like form has no place for embedded password
      // (only `user@host` is allowed before the `:`), and the regex already
      // anchors host + path shape.
      return;
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Repo URL must be HTTPS, SSH (ssh://...), or scp-like (git@host:path).",
      });
      return;
    }
    if (url.protocol !== "https:" && url.protocol !== "ssh:") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Repo URL must use HTTPS or SSH.",
      });
      return;
    }
    // Embedded password is always rejected. Embedded username is rejected
    // for HTTPS (credential leak); for SSH it's expected (`git@host`) so we
    // only block the password component there.
    if (url.password.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Repo URL must not include credentials.",
      });
      return;
    }
    if (url.protocol === "https:" && url.username.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Repo URL must not include credentials.",
      });
      return;
    }
  });

// -- context_tree --

export const orgContextTreeStorageSchema = z.object({
  repo: repoUrlSchema.optional(),
  branch: z.string().default("main"),
});

export const orgContextTreeInputSchema = z.object({
  /** Set / replace (HTTPS, ssh://, or scp-like — no embedded credentials). `null` clears. `undefined` leaves unchanged. */
  repo: repoUrlSchema.nullish(),
  /** Set / replace (non-empty). `null` clears (server falls back to "main"). `undefined` leaves unchanged. */
  branch: z.string().min(1).nullish(),
});

export const orgContextTreeOutputSchema = z.object({
  repo: z.string().optional(),
  branch: z.string().optional(),
});

// `github_integration` (per-org webhook secret cipher) was retired with the
// GitHub App ingestion cutover — webhook secrets now live in server env, and
// installations bind via `github_app_installations` instead. The JSONB key
// `webhookSecretCipher` is left untouched on legacy rows; a follow-up release
// drops the orphan rows in a separate migration (DP12).

// -- source_repos --

export const orgSourceReposStorageSchema = z.object({
  repos: z
    .array(
      z.object({
        url: repoUrlSchema,
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
   * `url` reuses `repoUrlSchema` — same protocol allow-list (HTTPS / SSH)
   * and no-embedded-credentials hardening as `context_tree.repo`.
   * `defaultBranch` is `min(1)` here on
   * the input boundary — the storage schema is wider so historical /
   * backfilled rows with an empty `defaultBranch` aren't rejected on read.
   */
  repos: z
    .array(
      z.object({
        url: repoUrlSchema,
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

export type OrgSourceReposStorage = OrgSettingStorage<"source_repos">;
export type OrgSourceReposInput = OrgSettingInput<"source_repos">;
export type OrgSourceReposOutput = OrgSettingOutput<"source_repos">;

export const orgSettingNamespaceSchema = z.enum(
  ORG_SETTINGS_NAMESPACE_KEYS as [OrgSettingNamespace, ...OrgSettingNamespace[]],
);

export function isOrgSettingNamespace(value: unknown): value is OrgSettingNamespace {
  return typeof value === "string" && (ORG_SETTINGS_NAMESPACE_KEYS as ReadonlyArray<string>).includes(value);
}
