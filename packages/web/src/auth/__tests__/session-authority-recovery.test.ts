import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCandidateTokenSnapshot, fingerprintCandidateTokenSnapshot } from "../session/candidate-tokens.js";
import {
  AuthSessionCoordinator,
  closeCoordinatorConnections,
  type VerifiedCandidateProof,
} from "../session/coordinator.js";
import { sessionErrorCodes } from "../session/errors.js";
import { type StorageArea, scrubLegacyPersistence } from "../session/legacy-scrub.js";
import { createAccountScopeKey } from "../session/scope.js";
import {
  type AcquisitionSessionAttempt,
  type AcquisitionTransitionPermit,
  type ActivationCertificate,
  createActivationCertificate,
  createCredentialRecord,
  createSessionAttempt,
} from "../session/types.js";

const SERVER_AUTHORITY = "https://hub.example.test/api/v1";

function memoryStorage(): StorageArea {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

function activation(label: string, generation: string): ActivationCertificate {
  const accountId = `account-${label}`;
  return createActivationCertificate({
    sessionEpoch: `epoch-${label}`,
    authGeneration: generation,
    transitionPermitId: `permit-${label}`,
    serverAuthority: SERVER_AUTHORITY,
    accountId,
    scopeKey: createAccountScopeKey(SERVER_AUTHORITY, accountId),
  });
}

function base64Url(value: string): string {
  return btoa(value).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function jwt(accountId: string, kind: "access" | "refresh", marker: string): string {
  return `${base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${base64Url(
    JSON.stringify({ sub: accountId, type: kind, exp: 2_100_000_000, marker }),
  )}.signature`;
}

async function credential(certificate: ActivationCertificate, marker = certificate.sessionEpoch) {
  const accessToken = jwt(certificate.accountId, "access", `access-${marker}`);
  const refreshToken = jwt(certificate.accountId, "refresh", `refresh-${marker}`);
  const fingerprinted = await fingerprintCandidateTokenSnapshot(
    createCandidateTokenSnapshot({ accessToken, refreshToken }),
    certificate.serverAuthority,
  );
  return createCredentialRecord({
    activation: certificate,
    credentialRevision: 0,
    credentialFingerprint: fingerprinted.credentialFingerprint,
    accessToken,
    refreshToken,
  });
}

function acquisitionAttempt(
  attemptId: string,
  baselineGeneration: string,
  sourceEpoch: string | null,
  expiresAt = Date.now() + 60_000,
): AcquisitionSessionAttempt {
  const value = createSessionAttempt({
    attemptId,
    kind: "acquisition",
    serverAuthority: SERVER_AUTHORITY,
    baselineGeneration,
    sourceEpoch,
    expiresAt,
    payload: { mappedTab: `tab-${attemptId}` },
  });
  if (value.kind !== "acquisition") throw new Error("expected acquisition attempt fixture");
  return value;
}

async function candidateProof(
  coordinator: AuthSessionCoordinator,
  attempt: AcquisitionSessionAttempt,
  target: ActivationCertificate,
  signal: AbortSignal = new AbortController().signal,
): Promise<VerifiedCandidateProof> {
  const targetCredential = await credential(target);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ user: { id: target.accountId } }), {
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
  return (
    await coordinator.requestCandidateMe({
      candidate: {
        accessToken: targetCredential.accessToken,
        refreshToken: targetCredential.refreshToken,
        credentialFingerprint: targetCredential.credentialFingerprint,
      },
      attempt,
      serverAuthority: target.serverAuthority,
      signal,
    })
  ).proof;
}

async function scrub(factory: IDBFactory) {
  return scrubLegacyPersistence({
    indexedDB: factory,
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
  });
}

async function reserve(
  factory: IDBFactory,
  coordinator: AuthSessionCoordinator,
  target: ActivationCertificate,
  attempt: AcquisitionSessionAttempt,
): Promise<Readonly<{ permit: AcquisitionTransitionPermit; proof: VerifiedCandidateProof }>> {
  await coordinator.putAttempt(attempt);
  const proof = await candidateProof(coordinator, attempt, target);
  const authority = await coordinator.readAuthority();
  const permit = await coordinator.reserveAcquisitionTransition(
    { generation: authority.generation, revision: authority.revision },
    proof,
    target,
    null,
    await scrub(factory),
  );
  return Object.freeze({ permit, proof });
}

afterEach(() => {
  closeCoordinatorConnections();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("auth transition crash recovery", () => {
  it("cancels an expired anonymous transition after reload loses its realm-local proof", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    const baselineNow = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(baselineNow);
    await coordinator.bootstrapAnonymous("generation-anonymous");

    const target = activation("target", "generation-target");
    const attempt = acquisitionAttempt("attempt-expiring", "generation-anonymous", null, baselineNow + 10);
    const { permit } = await reserve(factory, coordinator, target, attempt);
    vi.mocked(Date.now).mockReturnValue(baselineNow + 11);

    const reloaded = new AuthSessionCoordinator({ indexedDB: factory });
    await expect(reloaded.cancelAcquisitionTransition(permit, "generation-anonymous")).rejects.toMatchObject({
      code: sessionErrorCodes.invalidState,
    });
    await expect(reloaded.readAuthority()).resolves.toMatchObject({
      mode: "transition",
      generation: "generation-target",
    });
    await expect(reloaded.cancelAcquisitionTransition(permit, "generation-recovered")).resolves.toMatchObject({
      kind: "anonymous",
      authority: { mode: "none", generation: "generation-recovered" },
    });
    await expect(reloaded.readAuthority()).resolves.toMatchObject({
      mode: "none",
      generation: "generation-recovered",
    });
  });

  it("linearizes completion-first and cancellation-first without resurrecting either outcome", async () => {
    const completeFactory = new IDBFactory();
    const completing = new AuthSessionCoordinator({ indexedDB: completeFactory });
    await completing.bootstrapAnonymous("generation-anonymous");
    const completedTarget = activation("completed", "generation-completed");
    const completion = await reserve(
      completeFactory,
      completing,
      completedTarget,
      acquisitionAttempt("attempt-completed", "generation-anonymous", null),
    );
    await completing.completeAcquisitionTransition(completion.permit, completion.proof);
    const completedAuthority = await completing.readAuthority();
    await expect(
      completing.cancelAcquisitionTransition(completion.permit, "generation-stale-cancel"),
    ).resolves.toMatchObject({ kind: "superseded" });
    expect(await completing.readAuthority()).toEqual(completedAuthority);

    closeCoordinatorConnections();
    const cancelFactory = new IDBFactory();
    const cancelling = new AuthSessionCoordinator({ indexedDB: cancelFactory });
    await cancelling.bootstrapAnonymous("generation-anonymous");
    const cancelledTarget = activation("cancelled", "generation-cancelled-target");
    const cancellation = await reserve(
      cancelFactory,
      cancelling,
      cancelledTarget,
      acquisitionAttempt("attempt-cancelled", "generation-anonymous", null),
    );
    await cancelling.cancelAcquisitionTransition(cancellation.permit, "generation-cancelled");
    await expect(
      cancelling.completeAcquisitionTransition(cancellation.permit, cancellation.proof),
    ).rejects.toMatchObject({ code: sessionErrorCodes.admissionDenied });
    await expect(cancelling.readAuthority()).resolves.toMatchObject({
      mode: "none",
      generation: "generation-cancelled",
    });
  });

  it("blocks attempt mutation while the exact transition is still reserved", async () => {
    const factory = new IDBFactory();
    const coordinator = new AuthSessionCoordinator({ indexedDB: factory });
    await coordinator.bootstrapAnonymous("generation-anonymous");
    const target = activation("target", "generation-target");
    const targetAttempt = acquisitionAttempt("attempt-target", "generation-anonymous", null);
    const transition = await reserve(factory, coordinator, target, targetAttempt);
    await expect(
      coordinator.putAttempt(acquisitionAttempt("attempt-late", "generation-target", null)),
    ).rejects.toMatchObject({ code: sessionErrorCodes.admissionDenied });
    await expect(coordinator.deleteAttempt(targetAttempt.attemptId)).rejects.toMatchObject({
      code: sessionErrorCodes.admissionDenied,
    });

    await coordinator.cancelAcquisitionTransition(transition.permit, "generation-recovered");
  });
});
