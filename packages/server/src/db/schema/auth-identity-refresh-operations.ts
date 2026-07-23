import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Durable single-flight records for refresh-token rotation.
 *
 * Identity and user references deliberately are not foreign keys so unlink
 * and garbage collection can terminalize an in-flight operation instead of
 * cascading it away.
 */
export const authIdentityRefreshOperations = pgTable(
  "auth_identity_refresh_operations",
  {
    id: text("id").primaryKey(),
    identityId: text("identity_id").notNull(),
    userId: text("user_id").notNull(),
    provider: text("provider").notNull(),
    subject: text("subject").notNull(),
    sourceAuthorityRevision: bigint("source_authority_revision", { mode: "bigint" }).notNull(),
    sourceCredentialRevision: bigint("source_credential_revision", { mode: "bigint" }).notNull(),
    sourceCredentialFingerprint: text("source_credential_fingerprint").notNull(),
    phase: text("phase").notNull(),
    leaseRevision: bigint("lease_revision", { mode: "bigint" }).notNull(),
    leaseId: text("lease_id"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    hardExpiresAt: timestamp("hard_expires_at", { withTimezone: true }).notNull(),
    terminalReason: text("terminal_reason"),
    terminalReceipt: text("terminal_receipt"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_auth_identity_refresh_ops_identity_source_revision").on(
      table.identityId,
      table.sourceCredentialRevision,
    ),
    index("idx_auth_identity_refresh_ops_identity").on(table.identityId),
    index("idx_auth_identity_refresh_ops_phase_expiry").on(table.phase, table.hardExpiresAt),
    index("idx_auth_identity_refresh_ops_provider_subject").on(table.provider, table.subject),
    check("ck_auth_identity_refresh_ops_provider", sql`${table.provider} IN ('github', 'google')`),
    check(
      "ck_auth_identity_refresh_ops_phase",
      sql`${table.phase} IN (
        'reserved',
        'provider_dispatched',
        'terminal_success',
        'terminal_invalid',
        'terminal_uncertain',
        'cancelled_pre_dispatch',
        'superseded'
      )`,
    ),
    check("ck_auth_identity_refresh_ops_authority_revision", sql`${table.sourceAuthorityRevision} > 0`),
    check("ck_auth_identity_refresh_ops_credential_revision", sql`${table.sourceCredentialRevision} > 0`),
    check("ck_auth_identity_refresh_ops_lease_revision", sql`${table.leaseRevision} > 0`),
    check(
      "ck_auth_identity_refresh_ops_terminal_reason",
      sql`${table.terminalReason} IS NULL
        OR ${table.terminalReason} IN (
          'invalid_grant',
          'refresh_uncertain',
          'cancelled_pre_dispatch',
          'superseded'
        )`,
    ),
    check("ck_auth_identity_refresh_ops_expiry_order", sql`${table.hardExpiresAt} > ${table.createdAt}`),
    check(
      "ck_auth_identity_refresh_ops_lease_shape",
      sql`(
        (
          ${table.leaseId} IS NULL
          AND ${table.leaseUntil} IS NULL
        )
        OR (
          ${table.leaseId} IS NOT NULL
          AND ${table.leaseUntil} IS NOT NULL
          AND ${table.leaseRevision} > 0
          AND ${table.leaseUntil} > ${table.createdAt}
          AND ${table.leaseUntil} <= ${table.hardExpiresAt}
        )
      )`,
    ),
    check(
      "ck_auth_identity_refresh_ops_phase_shape",
      sql`(
        (
          ${table.phase} IN ('reserved', 'provider_dispatched')
          AND ${table.leaseId} IS NOT NULL
          AND ${table.leaseUntil} IS NOT NULL
          AND ${table.leaseRevision} > 0
          AND ${table.terminalReason} IS NULL
          AND ${table.terminalReceipt} IS NULL
        )
        OR (
          ${table.phase} = 'terminal_success'
          AND ${table.leaseId} IS NULL
          AND ${table.leaseUntil} IS NULL
          AND ${table.terminalReason} IS NULL
          AND ${table.terminalReceipt} IS NOT NULL
        )
        OR (
          ${table.phase} = 'terminal_invalid'
          AND ${table.leaseId} IS NULL
          AND ${table.leaseUntil} IS NULL
          AND ${table.terminalReason} IS NOT NULL
          AND ${table.terminalReason} = 'invalid_grant'
          AND ${table.terminalReceipt} IS NOT NULL
        )
        OR (
          ${table.phase} = 'terminal_uncertain'
          AND ${table.leaseId} IS NULL
          AND ${table.leaseUntil} IS NULL
          AND ${table.terminalReason} IS NOT NULL
          AND ${table.terminalReason} = 'refresh_uncertain'
          AND ${table.terminalReceipt} IS NOT NULL
        )
        OR (
          ${table.phase} = 'cancelled_pre_dispatch'
          AND ${table.leaseId} IS NULL
          AND ${table.leaseUntil} IS NULL
          AND ${table.terminalReason} IS NOT NULL
          AND ${table.terminalReason} = 'cancelled_pre_dispatch'
          AND ${table.terminalReceipt} IS NOT NULL
        )
        OR (
          ${table.phase} = 'superseded'
          AND ${table.leaseId} IS NULL
          AND ${table.leaseUntil} IS NULL
          AND ${table.terminalReason} IS NOT NULL
          AND ${table.terminalReason} = 'superseded'
          AND ${table.terminalReceipt} IS NOT NULL
        )
      )`,
    ),
  ],
);
