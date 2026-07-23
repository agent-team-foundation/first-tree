import { sql } from "drizzle-orm";
import { bigint, check, index, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { users } from "./users.js";

/**
 * Third-party / local auth identities for a user. Models "how does this user
 * prove they are who they say they are". A single user MAY have multiple
 * identities (e.g. GitHub login + future email/password) but each
 * (provider, identifier) tuple maps to exactly one user.
 *
 * v1 supported shapes:
 *   - GitHub OAuth: provider='github', identifier=<github numeric id>,
 *     email=<primary>, credential_type=null
 *   - Future Email + password: provider='email', identifier=<email>,
 *     credential_type='password', credential_payload={ hash }
 *   - Future Email + magic link: provider='email', identifier=<email>,
 *     credential_type=null
 *   - Future Webauthn / passkey: credential_type='webauthn',
 *     credential_payload={ pubkey, counter }
 *
 * v1 explicitly does NOT support multi-factor on the same identity — the
 * (provider, identifier) UNIQUE constraint precludes two credential rows for
 * the same identifier. v2 splits credential_type / credential_payload into
 * a separate auth_credentials table; the migration is recorded in the
 * proposal so the upgrade path is unambiguous.
 *
 * The legacy `users.password_hash` column is preserved for backwards-compat
 * with self-host installs created before this milestone; new SaaS users get
 * a non-functional placeholder there and a real `auth_identities` row.
 */
export const authIdentities = pgTable(
  "auth_identities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "github" | "google" | "email" (extend as needed). */
    provider: text("provider").notNull(),
    /** Provider-stable identifier (numeric id, sub claim, email address, …). */
    identifier: text("identifier").notNull(),
    /** Optional email snapshot from the provider — purely contact info. */
    email: text("email"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    /** null (OAuth) | "password" | "webauthn" — splits in v2 if MFA is needed. */
    credentialType: text("credential_type"),
    credentialPayload: jsonb("credential_payload").$type<Record<string, unknown>>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    authorityRevision: bigint("authority_revision", { mode: "bigint" }).notNull().default(sql`1`),
    credentialRevision: bigint("credential_revision", { mode: "bigint" }).notNull().default(sql`1`),
    credentialState: text("credential_state"),
    pendingRefreshOperationId: text("pending_refresh_operation_id"),
    retiredSourceCredentialRevision: bigint("retired_source_credential_revision", { mode: "bigint" }),
    credentialStateReason: text("credential_state_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_auth_identities_provider_identifier").on(table.provider, table.identifier),
    index("idx_auth_identities_user").on(table.userId),
    index("idx_auth_identities_email").on(table.email),
    unique("uq_auth_identities_user_provider").on(table.userId, table.provider),
    check("ck_auth_identities_authority_revision", sql`${table.authorityRevision} > 0`),
    check("ck_auth_identities_credential_revision", sql`${table.credentialRevision} > 0`),
    check(
      "ck_auth_identities_retired_source_revision",
      sql`${table.retiredSourceCredentialRevision} IS NULL OR ${table.retiredSourceCredentialRevision} > 0`,
    ),
    check(
      "ck_auth_identities_credential_state",
      sql`${table.credentialState} IN ('active', 'refresh_pending', 'reauth_required')`,
    ),
    check(
      "ck_auth_identities_credential_state_reason",
      sql`${table.credentialStateReason} IN ('refresh_uncertain', 'invalid_grant', 'corrupt')`,
    ),
    check(
      "ck_auth_identities_credential_state_coherence",
      sql`(
        (
          ${table.credentialState} IS NULL
          AND ${table.pendingRefreshOperationId} IS NULL
          AND ${table.retiredSourceCredentialRevision} IS NULL
          AND ${table.credentialStateReason} IS NULL
        )
        OR (
          ${table.credentialState} = 'active'
          AND ${table.pendingRefreshOperationId} IS NULL
          AND ${table.retiredSourceCredentialRevision} IS NULL
          AND ${table.credentialStateReason} IS NULL
        )
        OR (
          ${table.credentialState} = 'refresh_pending'
          AND ${table.pendingRefreshOperationId} IS NOT NULL
          AND ${table.retiredSourceCredentialRevision} IS NOT NULL
          AND ${table.credentialRevision} > ${table.retiredSourceCredentialRevision}
          AND ${table.credentialRevision} - ${table.retiredSourceCredentialRevision} = 1
          AND ${table.credentialStateReason} IS NULL
        )
        OR (
          ${table.credentialState} = 'reauth_required'
          AND ${table.pendingRefreshOperationId} IS NULL
          AND ${table.retiredSourceCredentialRevision} IS NOT NULL
          AND ${table.credentialRevision} > ${table.retiredSourceCredentialRevision}
          AND ${table.credentialRevision} - ${table.retiredSourceCredentialRevision} = 2
          AND ${table.credentialStateReason} IS NOT NULL
        )
      )`,
    ),
  ],
);
