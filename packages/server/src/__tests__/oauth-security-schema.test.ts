import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authIdentities } from "../db/schema/auth-identities.js";
import { authIdentityProviderHeads } from "../db/schema/auth-identity-provider-heads.js";
import { authIdentityRefreshOperations } from "../db/schema/auth-identity-refresh-operations.js";
import { authIdentityRetirementFences } from "../db/schema/auth-identity-retirement-fences.js";
import { oauthTransactions } from "../db/schema/oauth-transactions.js";
import { users } from "../db/schema/users.js";
import { useTestApp } from "./helpers.js";

const BASE_TIME = Date.parse("2026-07-23T00:00:00.000Z");

function at(offsetMs: number): Date {
  return new Date(BASE_TIME + offsetMs);
}

function unique(label: string): string {
  return `${label}-${randomUUID()}`;
}

async function expectConstraint(statement: PromiseLike<unknown>, constraint: string): Promise<void> {
  const resolved = Symbol("resolved");
  let rejection: unknown = resolved;
  try {
    await statement;
  } catch (error) {
    rejection = error;
  }
  if (rejection === resolved) {
    expect.fail(`Expected ${constraint} to reject the row`);
  }

  const evidence: string[] = [];
  let current: unknown = rejection;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const constraintName = Reflect.get(current, "constraint_name");
    if (typeof constraintName === "string") evidence.push(constraintName);
    evidence.push(current.message);
    const cause = Reflect.get(current, "cause");
    if (cause === current) break;
    current = cause;
  }
  expect(evidence.join(" ")).toContain(constraint);
}

function acquisitionIssued(overrides: Partial<typeof oauthTransactions.$inferInsert> = {}) {
  return {
    id: unique("oauth"),
    kind: "acquisition",
    flowKind: "acquisition_sign_in",
    provider: "github",
    serverAuthority: "https://server.example/api/v1",
    providerGeneration: 1n,
    publicHandleHash: unique("public"),
    replaySecretHash: unique("replay"),
    verifierHash: unique("verifier"),
    flowProofHash: unique("proof"),
    encryptedPayload: unique("payload"),
    payloadKeyId: "key-v1",
    phase: "issued",
    createdAt: at(0),
    expiresAt: at(8 * 60_000),
    updatedAt: at(0),
    ...overrides,
  } satisfies typeof oauthTransactions.$inferInsert;
}

function refreshOperation(overrides: Partial<typeof authIdentityRefreshOperations.$inferInsert> = {}) {
  return {
    id: unique("refresh-op"),
    identityId: unique("identity"),
    userId: unique("user"),
    provider: "github",
    subject: unique("subject"),
    sourceAuthorityRevision: 1n,
    sourceCredentialRevision: 1n,
    sourceCredentialFingerprint: unique("fingerprint"),
    phase: "reserved",
    leaseRevision: 1n,
    leaseId: unique("lease"),
    leaseUntil: at(4 * 60_000),
    hardExpiresAt: at(8 * 60_000),
    createdAt: at(0),
    updatedAt: at(0),
    ...overrides,
  } satisfies typeof authIdentityRefreshOperations.$inferInsert;
}

describe("OAuth security schema invariants", () => {
  const getApp = useTestApp();

  it("fails closed when a statement unexpectedly resolves", async () => {
    await expect(expectConstraint(Promise.resolve(), "ck_missing_constraint")).rejects.toThrow(
      "Expected ck_missing_constraint to reject the row",
    );
  });

  it("accepts valid OAuth phases and rejects invalid flow, expiry, lease, and terminal shapes", async () => {
    const app = getApp();

    await expect(app.db.insert(oauthTransactions).values(acquisitionIssued())).resolves.toBeDefined();
    await expect(
      app.db.insert(oauthTransactions).values(
        acquisitionIssued({
          phase: "minting",
          userId: unique("user"),
          identityId: unique("identity"),
          receiptId: unique("receipt"),
          bootstrapEnvelope: unique("bootstrap"),
          bootstrapDigest: unique("bootstrap-digest"),
          bootstrapKeyId: "key-v1",
          mintLeaseRevision: 1n,
          mintLeaseId: unique("mint-lease"),
          mintLeaseUntil: at(4 * 60_000),
        }),
      ),
    ).resolves.toBeDefined();
    await expect(
      app.db.insert(oauthTransactions).values(
        acquisitionIssued({
          phase: "terminal_success",
          userId: unique("user"),
          identityId: unique("identity"),
          receiptId: unique("receipt"),
          bootstrapEnvelope: unique("bootstrap"),
          bootstrapDigest: unique("bootstrap-digest"),
          bootstrapKeyId: "key-v1",
          mintLeaseRevision: 1n,
          terminalEnvelope: unique("terminal"),
          terminalKeyId: "key-v1",
          terminalAt: at(5 * 60_000),
        }),
      ),
    ).resolves.toBeDefined();
    await expect(
      app.db.insert(oauthTransactions).values(
        acquisitionIssued({
          kind: "management",
          flowKind: "identity_link",
          phase: "terminal_success",
          userId: unique("user"),
          identityId: unique("identity"),
          receiptId: unique("receipt"),
          finalizationLeaseRevision: 1n,
          terminalEnvelope: unique("terminal"),
          terminalKeyId: "key-v1",
          terminalAt: at(5 * 60_000),
        }),
      ),
    ).resolves.toBeDefined();
    await expect(
      app.db.insert(oauthTransactions).values(
        acquisitionIssued({
          kind: "management",
          flowKind: "identity_link",
          phase: "management_finalizing",
          userId: unique("user"),
          finalizationLeaseRevision: 1n,
          finalizationLeaseId: unique("finalization-lease"),
          finalizationLeaseUntil: at(4 * 60_000),
        }),
      ),
    ).resolves.toBeDefined();

    await expectConstraint(
      app.db.insert(oauthTransactions).values(acquisitionIssued({ expiresAt: at(10 * 60_000 + 1) })),
      "ck_oauth_transactions_expiry_order",
    );
    await expectConstraint(
      app.db.insert(oauthTransactions).values(
        acquisitionIssued({
          kind: "management",
          flowKind: "github_install_return",
          provider: "google",
          userId: unique("user"),
          identityId: unique("identity"),
        }),
      ),
      "ck_oauth_transactions_provider_flow",
    );
    await expectConstraint(
      app.db.insert(oauthTransactions).values(
        acquisitionIssued({
          phase: "minting",
          userId: unique("user"),
          identityId: unique("identity"),
        }),
      ),
      "ck_oauth_transactions_phase_shape",
    );
    await expectConstraint(
      app.db.insert(oauthTransactions).values(
        acquisitionIssued({
          kind: "management",
          flowKind: "identity_link",
          phase: "minting",
          userId: unique("user"),
          identityId: unique("identity"),
          receiptId: unique("receipt"),
          bootstrapEnvelope: unique("bootstrap"),
          bootstrapDigest: unique("bootstrap-digest"),
          bootstrapKeyId: "key-v1",
          mintLeaseRevision: 1n,
          mintLeaseId: unique("mint-lease"),
          mintLeaseUntil: at(4 * 60_000),
        }),
      ),
      "ck_oauth_transactions_kind_phase",
    );
    await expectConstraint(
      app.db.insert(oauthTransactions).values(
        acquisitionIssued({
          phase: "terminal_failure",
          terminalAt: at(3 * 60_000),
          terminalReason: "provider_error",
          terminalEnvelope: unique("terminal"),
          terminalKeyId: "key-v1",
        }),
      ),
      "ck_oauth_transactions_phase_shape",
    );
    await expectConstraint(
      app.db.insert(oauthTransactions).values(
        acquisitionIssued({
          kind: "management",
          flowKind: "identity_link",
          phase: "management_finalizing",
          userId: unique("user"),
          finalizationLeaseRevision: 1n,
          finalizationLeaseId: unique("finalization-lease"),
          finalizationLeaseUntil: at(9 * 60_000),
        }),
      ),
      "ck_oauth_transactions_finalization_lease_shape",
    );
  });

  it("accepts valid refresh operation phases and rejects incomplete or contradictory terminals", async () => {
    const app = getApp();

    await expect(app.db.insert(authIdentityRefreshOperations).values(refreshOperation())).resolves.toBeDefined();
    await expect(
      app.db.insert(authIdentityRefreshOperations).values(
        refreshOperation({
          phase: "terminal_success",
          leaseId: null,
          leaseUntil: null,
          terminalReceipt: unique("receipt"),
        }),
      ),
    ).resolves.toBeDefined();

    await expectConstraint(
      app.db.insert(authIdentityRefreshOperations).values(
        refreshOperation({
          phase: "provider_dispatched",
          leaseRevision: 1n,
          leaseId: null,
          leaseUntil: null,
        }),
      ),
      "ck_auth_identity_refresh_ops_phase_shape",
    );
    await expectConstraint(
      app.db.insert(authIdentityRefreshOperations).values(
        refreshOperation({
          phase: "terminal_success",
          leaseRevision: 0n,
          leaseId: null,
          leaseUntil: null,
          terminalReceipt: unique("receipt"),
        }),
      ),
      "ck_auth_identity_refresh_ops_lease_revision",
    );
    await expectConstraint(
      app.db.insert(authIdentityRefreshOperations).values(
        refreshOperation({
          phase: "terminal_success",
          leaseId: null,
          leaseUntil: null,
        }),
      ),
      "ck_auth_identity_refresh_ops_phase_shape",
    );
    await expectConstraint(
      app.db.insert(authIdentityRefreshOperations).values(
        refreshOperation({
          phase: "terminal_uncertain",
          leaseId: null,
          leaseUntil: null,
          terminalReason: "invalid_grant",
          terminalReceipt: unique("receipt"),
        }),
      ),
      "ck_auth_identity_refresh_ops_phase_shape",
    );
  });

  it("restricts provider heads to supported providers and non-negative generations", async () => {
    const app = getApp();

    await expect(
      app.db.insert(authIdentityProviderHeads).values({ provider: "github", generation: 0n }),
    ).resolves.toBeDefined();
    await expectConstraint(
      app.db.insert(authIdentityProviderHeads).values({ provider: "gitlab", generation: 0n }),
      "ck_auth_identity_provider_heads_provider",
    );
    await expectConstraint(
      app.db.insert(authIdentityProviderHeads).values({ provider: "google", generation: -1n }),
      "ck_auth_identity_provider_heads_generation",
    );
    await expect(
      app.db.insert(authIdentityProviderHeads).values({ provider: "google", generation: 2n }),
    ).resolves.toBeDefined();
  });

  it("enforces exact credential revision ordering for pending refresh and reauthentication states", async () => {
    const app = getApp();

    async function insertIdentity(
      state: "refresh_pending" | "reauth_required",
      credentialRevision: bigint,
      retiredSourceCredentialRevision: bigint,
    ): Promise<void> {
      const userId = unique("user");
      await app.db.insert(users).values({
        id: userId,
        username: unique("schema-user"),
        passwordHash: "x",
        displayName: "OAuth schema fixture",
      });
      await app.db.insert(authIdentities).values({
        id: unique("identity"),
        userId,
        provider: "github",
        identifier: unique("subject"),
        metadata: {},
        authorityRevision: 1n,
        credentialRevision,
        credentialState: state,
        pendingRefreshOperationId: state === "refresh_pending" ? unique("pending-operation") : null,
        retiredSourceCredentialRevision,
        credentialStateReason: state === "reauth_required" ? "refresh_uncertain" : null,
      });
    }

    await expect(insertIdentity("refresh_pending", 2n, 1n)).resolves.toBeUndefined();
    await expectConstraint(insertIdentity("refresh_pending", 3n, 1n), "ck_auth_identities_credential_state_coherence");
    await expect(insertIdentity("reauth_required", 3n, 1n)).resolves.toBeUndefined();
    await expectConstraint(insertIdentity("reauth_required", 2n, 1n), "ck_auth_identities_credential_state_coherence");
  });

  it("requires retirement fences to expire after their retirement point", async () => {
    const app = getApp();

    await expect(
      app.db.insert(authIdentityRetirementFences).values({
        provider: "github",
        subject: unique("subject"),
        retiredIdentityId: unique("identity"),
        retiredUserId: unique("user"),
        retiredGeneration: 1n,
        retiredAt: at(0),
        expiresAt: at(8 * 60_000),
      }),
    ).resolves.toBeDefined();
    await expectConstraint(
      app.db.insert(authIdentityRetirementFences).values({
        provider: "github",
        subject: unique("subject"),
        retiredIdentityId: unique("identity"),
        retiredUserId: unique("user"),
        retiredGeneration: 1n,
        retiredAt: at(8 * 60_000),
        expiresAt: at(0),
      }),
      "ck_auth_identity_retirement_fences_expiry_order",
    );
  });
});
