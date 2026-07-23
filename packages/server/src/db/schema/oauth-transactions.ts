import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * One-use OAuth security transactions.
 *
 * User and identity references remain plain identifiers so account/identity
 * deletion cannot erase an in-flight or terminal security record. Encrypted
 * envelopes and their key identifiers are opaque to the schema.
 */
export const oauthTransactions = pgTable(
  "oauth_transactions",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    flowKind: text("flow_kind").notNull(),
    provider: text("provider").notNull(),
    serverAuthority: text("server_authority").notNull(),
    providerGeneration: bigint("provider_generation", { mode: "bigint" }).notNull(),
    publicHandleHash: text("public_handle_hash").notNull(),
    replaySecretHash: text("replay_secret_hash").notNull(),
    verifierHash: text("verifier_hash").notNull(),
    flowProofHash: text("flow_proof_hash").notNull(),
    encryptedPayload: text("encrypted_payload").notNull(),
    payloadKeyId: text("payload_key_id").notNull(),
    userId: text("user_id"),
    identityId: text("identity_id"),
    phase: text("phase").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    receiptId: text("receipt_id"),
    bootstrapEnvelope: text("bootstrap_envelope"),
    bootstrapDigest: text("bootstrap_digest"),
    bootstrapKeyId: text("bootstrap_key_id"),
    mintLeaseRevision: bigint("mint_lease_revision", { mode: "bigint" }).notNull().default(sql`0`),
    mintLeaseId: text("mint_lease_id"),
    mintLeaseUntil: timestamp("mint_lease_until", { withTimezone: true }),
    finalizationLeaseRevision: bigint("finalization_lease_revision", { mode: "bigint" }).notNull().default(sql`0`),
    finalizationLeaseId: text("finalization_lease_id"),
    finalizationLeaseUntil: timestamp("finalization_lease_until", { withTimezone: true }),
    terminalEnvelope: text("terminal_envelope"),
    terminalKeyId: text("terminal_key_id"),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    terminalReason: text("terminal_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_oauth_transactions_public_handle_hash").on(table.publicHandleHash),
    index("idx_oauth_transactions_provider_phase_expiry").on(table.provider, table.phase, table.expiresAt),
    index("idx_oauth_transactions_expiry").on(table.expiresAt),
    index("idx_oauth_transactions_user").on(table.userId),
    index("idx_oauth_transactions_identity").on(table.identityId),
    check("ck_oauth_transactions_kind", sql`${table.kind} IN ('acquisition', 'management')`),
    check(
      "ck_oauth_transactions_flow_kind",
      sql`${table.flowKind} IN (
        'acquisition_sign_in',
        'identity_link',
        'identity_unlink',
        'github_install_return'
      )`,
    ),
    check("ck_oauth_transactions_provider", sql`${table.provider} IN ('github', 'google')`),
    check(
      "ck_oauth_transactions_phase",
      sql`${table.phase} IN (
        'issued',
        'provider_exchanging',
        'bootstrap_committed',
        'minting',
        'management_finalizing',
        'terminal_success',
        'terminal_failure',
        'cancelled'
      )`,
    ),
    check(
      "ck_oauth_transactions_kind_flow",
      sql`(
        (${table.kind} = 'acquisition' AND ${table.flowKind} = 'acquisition_sign_in')
        OR (
          ${table.kind} = 'management'
          AND ${table.flowKind} IN ('identity_link', 'identity_unlink', 'github_install_return')
        )
      )`,
    ),
    check(
      "ck_oauth_transactions_provider_flow",
      sql`${table.flowKind} <> 'github_install_return' OR ${table.provider} = 'github'`,
    ),
    check(
      "ck_oauth_transactions_kind_phase",
      sql`(
        (
          ${table.kind} = 'acquisition'
          AND ${table.phase} IN (
            'issued',
            'provider_exchanging',
            'bootstrap_committed',
            'minting',
            'terminal_success',
            'terminal_failure',
            'cancelled'
          )
        )
        OR (
          ${table.kind} = 'management'
          AND ${table.phase} IN (
            'issued',
            'provider_exchanging',
            'management_finalizing',
            'terminal_success',
            'terminal_failure',
            'cancelled'
          )
        )
      )`,
    ),
    check("ck_oauth_transactions_provider_generation", sql`${table.providerGeneration} >= 0`),
    check("ck_oauth_transactions_mint_lease_revision", sql`${table.mintLeaseRevision} >= 0`),
    check("ck_oauth_transactions_finalization_lease_revision", sql`${table.finalizationLeaseRevision} >= 0`),
    check(
      "ck_oauth_transactions_expiry_order",
      sql`${table.expiresAt} > ${table.createdAt}
        AND ${table.expiresAt} <= ${table.createdAt} + INTERVAL '10 minutes'`,
    ),
    check(
      "ck_oauth_transactions_terminal_time",
      sql`${table.terminalAt} IS NULL
        OR (
          ${table.terminalAt} >= ${table.createdAt}
          AND ${table.terminalAt} <= ${table.expiresAt}
        )`,
    ),
    check(
      "ck_oauth_transactions_bootstrap_tuple",
      sql`(
        (
          ${table.bootstrapEnvelope} IS NULL
          AND ${table.bootstrapDigest} IS NULL
          AND ${table.bootstrapKeyId} IS NULL
        )
        OR (
          ${table.bootstrapEnvelope} IS NOT NULL
          AND ${table.bootstrapDigest} IS NOT NULL
          AND ${table.bootstrapKeyId} IS NOT NULL
        )
      )`,
    ),
    check(
      "ck_oauth_transactions_mint_lease_shape",
      sql`(
        (
          ${table.mintLeaseId} IS NULL
          AND ${table.mintLeaseUntil} IS NULL
        )
        OR (
          ${table.mintLeaseId} IS NOT NULL
          AND ${table.mintLeaseUntil} IS NOT NULL
          AND ${table.mintLeaseRevision} > 0
          AND ${table.mintLeaseUntil} > ${table.createdAt}
          AND ${table.mintLeaseUntil} <= ${table.expiresAt}
        )
      )`,
    ),
    check(
      "ck_oauth_transactions_finalization_lease_shape",
      sql`(
        (
          ${table.finalizationLeaseId} IS NULL
          AND ${table.finalizationLeaseUntil} IS NULL
        )
        OR (
          ${table.finalizationLeaseId} IS NOT NULL
          AND ${table.finalizationLeaseUntil} IS NOT NULL
          AND ${table.finalizationLeaseRevision} > 0
          AND ${table.finalizationLeaseUntil} > ${table.createdAt}
          AND ${table.finalizationLeaseUntil} <= ${table.expiresAt}
        )
      )`,
    ),
    check(
      "ck_oauth_transactions_owner_shape",
      sql`(
        (
          ${table.flowKind} = 'acquisition_sign_in'
          AND (
            (
              ${table.phase} IN ('issued', 'provider_exchanging')
              AND ${table.userId} IS NULL
              AND ${table.identityId} IS NULL
            )
            OR (
              ${table.phase} IN ('bootstrap_committed', 'minting', 'terminal_success')
              AND ${table.userId} IS NOT NULL
              AND ${table.identityId} IS NOT NULL
            )
            OR (
              ${table.phase} IN ('terminal_failure', 'cancelled')
              AND (
                (
                  ${table.bootstrapEnvelope} IS NULL
                  AND ${table.userId} IS NULL
                  AND ${table.identityId} IS NULL
                )
                OR (
                  ${table.bootstrapEnvelope} IS NOT NULL
                  AND ${table.userId} IS NOT NULL
                  AND ${table.identityId} IS NOT NULL
                )
              )
            )
          )
        )
        OR (
          ${table.flowKind} = 'identity_link'
          AND ${table.userId} IS NOT NULL
          AND (${table.phase} <> 'terminal_success' OR ${table.identityId} IS NOT NULL)
        )
        OR (
          ${table.flowKind} IN ('identity_unlink', 'github_install_return')
          AND ${table.userId} IS NOT NULL
          AND ${table.identityId} IS NOT NULL
        )
      )`,
    ),
    check(
      "ck_oauth_transactions_phase_shape",
      sql`(
        (
          ${table.phase} IN ('issued', 'provider_exchanging')
          AND ${table.receiptId} IS NULL
          AND ${table.bootstrapEnvelope} IS NULL
          AND ${table.bootstrapDigest} IS NULL
          AND ${table.bootstrapKeyId} IS NULL
          AND ${table.mintLeaseRevision} = 0
          AND ${table.mintLeaseId} IS NULL
          AND ${table.mintLeaseUntil} IS NULL
          AND ${table.finalizationLeaseRevision} = 0
          AND ${table.finalizationLeaseId} IS NULL
          AND ${table.finalizationLeaseUntil} IS NULL
          AND ${table.terminalEnvelope} IS NULL
          AND ${table.terminalKeyId} IS NULL
          AND ${table.terminalAt} IS NULL
          AND ${table.terminalReason} IS NULL
        )
        OR (
          ${table.phase} = 'bootstrap_committed'
          AND ${table.receiptId} IS NOT NULL
          AND ${table.bootstrapEnvelope} IS NOT NULL
          AND ${table.bootstrapDigest} IS NOT NULL
          AND ${table.bootstrapKeyId} IS NOT NULL
          AND ${table.mintLeaseRevision} = 0
          AND ${table.mintLeaseId} IS NULL
          AND ${table.mintLeaseUntil} IS NULL
          AND ${table.finalizationLeaseRevision} = 0
          AND ${table.finalizationLeaseId} IS NULL
          AND ${table.finalizationLeaseUntil} IS NULL
          AND ${table.terminalEnvelope} IS NULL
          AND ${table.terminalKeyId} IS NULL
          AND ${table.terminalAt} IS NULL
          AND ${table.terminalReason} IS NULL
        )
        OR (
          ${table.phase} = 'minting'
          AND ${table.receiptId} IS NOT NULL
          AND ${table.bootstrapEnvelope} IS NOT NULL
          AND ${table.bootstrapDigest} IS NOT NULL
          AND ${table.bootstrapKeyId} IS NOT NULL
          AND ${table.mintLeaseRevision} > 0
          AND ${table.mintLeaseId} IS NOT NULL
          AND ${table.mintLeaseUntil} IS NOT NULL
          AND ${table.finalizationLeaseRevision} = 0
          AND ${table.finalizationLeaseId} IS NULL
          AND ${table.finalizationLeaseUntil} IS NULL
          AND ${table.terminalEnvelope} IS NULL
          AND ${table.terminalKeyId} IS NULL
          AND ${table.terminalAt} IS NULL
          AND ${table.terminalReason} IS NULL
        )
        OR (
          ${table.phase} = 'management_finalizing'
          AND ${table.receiptId} IS NULL
          AND ${table.bootstrapEnvelope} IS NULL
          AND ${table.bootstrapDigest} IS NULL
          AND ${table.bootstrapKeyId} IS NULL
          AND ${table.mintLeaseRevision} = 0
          AND ${table.mintLeaseId} IS NULL
          AND ${table.mintLeaseUntil} IS NULL
          AND ${table.finalizationLeaseRevision} > 0
          AND ${table.finalizationLeaseId} IS NOT NULL
          AND ${table.finalizationLeaseUntil} IS NOT NULL
          AND ${table.terminalEnvelope} IS NULL
          AND ${table.terminalKeyId} IS NULL
          AND ${table.terminalAt} IS NULL
          AND ${table.terminalReason} IS NULL
        )
        OR (
          ${table.phase} = 'terminal_success'
          AND ${table.receiptId} IS NOT NULL
          AND ${table.mintLeaseId} IS NULL
          AND ${table.mintLeaseUntil} IS NULL
          AND ${table.finalizationLeaseId} IS NULL
          AND ${table.finalizationLeaseUntil} IS NULL
          AND ${table.terminalEnvelope} IS NOT NULL
          AND ${table.terminalKeyId} IS NOT NULL
          AND ${table.terminalAt} IS NOT NULL
          AND ${table.terminalReason} IS NULL
          AND (
            (
              ${table.kind} = 'acquisition'
              AND ${table.bootstrapEnvelope} IS NOT NULL
              AND ${table.bootstrapDigest} IS NOT NULL
              AND ${table.bootstrapKeyId} IS NOT NULL
              AND ${table.mintLeaseRevision} > 0
              AND ${table.finalizationLeaseRevision} = 0
            )
            OR (
              ${table.kind} = 'management'
              AND ${table.bootstrapEnvelope} IS NULL
              AND ${table.bootstrapDigest} IS NULL
              AND ${table.bootstrapKeyId} IS NULL
              AND ${table.mintLeaseRevision} = 0
              AND ${table.finalizationLeaseRevision} > 0
            )
          )
        )
        OR (
          ${table.phase} IN ('terminal_failure', 'cancelled')
          AND ${table.mintLeaseId} IS NULL
          AND ${table.mintLeaseUntil} IS NULL
          AND ${table.finalizationLeaseId} IS NULL
          AND ${table.finalizationLeaseUntil} IS NULL
          AND ${table.terminalEnvelope} IS NULL
          AND ${table.terminalKeyId} IS NULL
          AND ${table.terminalAt} IS NOT NULL
          AND ${table.terminalReason} IS NOT NULL
          AND (
            (
              ${table.kind} = 'acquisition'
              AND ${table.finalizationLeaseRevision} = 0
              AND (
                (
                  ${table.receiptId} IS NULL
                  AND ${table.bootstrapEnvelope} IS NULL
                  AND ${table.bootstrapDigest} IS NULL
                  AND ${table.bootstrapKeyId} IS NULL
                  AND ${table.mintLeaseRevision} = 0
                )
                OR (
                  ${table.receiptId} IS NOT NULL
                  AND ${table.bootstrapEnvelope} IS NOT NULL
                  AND ${table.bootstrapDigest} IS NOT NULL
                  AND ${table.bootstrapKeyId} IS NOT NULL
                )
              )
            )
            OR (
              ${table.kind} = 'management'
              AND ${table.receiptId} IS NULL
              AND ${table.bootstrapEnvelope} IS NULL
              AND ${table.bootstrapDigest} IS NULL
              AND ${table.bootstrapKeyId} IS NULL
              AND ${table.mintLeaseRevision} = 0
            )
          )
        )
      )`,
    ),
  ],
);
