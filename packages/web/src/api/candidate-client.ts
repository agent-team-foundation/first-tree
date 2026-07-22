import {
  type CandidateTokenPairInput,
  createCandidateTokenSnapshot,
  type FingerprintedCandidateTokenSnapshot,
  fingerprintCandidateTokenSnapshot,
} from "../auth/session/candidate-tokens.js";
import { type AcquisitionSessionAttempt, validateSessionAttempt } from "../auth/session/types.js";
import { canonicalizeServerAuthority, expectedAuthorityHeaders, readBoundedResponseText } from "./server-authority.js";

const BASE_URL = "/api/v1";
const MAX_ME_RESPONSE_BYTES = 512 * 1024;

export class CandidateApiError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CandidateApiError";
  }
}

export type CandidateDispatch = (start: () => Promise<Response>) => Promise<Response>;

export type CandidateMeResult = Readonly<{
  accountId: string;
  payload: Readonly<Record<string, unknown>>;
  proof: VerifiedCandidateProof;
}>;

export type CandidateAttemptBinding = AcquisitionSessionAttempt;

export type CandidateMeRequest = Readonly<{
  candidate: CandidateTokenPairInput & Partial<Pick<FingerprintedCandidateTokenSnapshot, "credentialFingerprint">>;
  attempt: CandidateAttemptBinding;
  serverAuthority: string;
  signal: AbortSignal;
  /** Starts the request only after a fresh authoritative dispatch admission. */
  dispatch: CandidateDispatch;
  /** Rechecks the exact attempt/lease/authority after bytes are parsed. */
  assertResponseCurrent: () => Promise<void>;
}>;

const verifiedCandidateProofBrand: unique symbol = Symbol("first-tree.verified-candidate-proof");

export type VerifiedCandidateProof = Readonly<{
  [verifiedCandidateProofBrand]: true;
}>;

export type VerifiedCandidateEvidence = Readonly<{
  candidate: FingerprintedCandidateTokenSnapshot;
  serverAuthority: string;
  accountId: string;
  attempt: CandidateAttemptBinding;
}>;

type ProofState = {
  evidence: VerifiedCandidateEvidence;
  state: "available" | "claimed" | "consumed";
};

const verifiedCandidateProofs = new WeakMap<VerifiedCandidateProof, ProofState>();

function createVerifiedCandidateProof(evidence: VerifiedCandidateEvidence): VerifiedCandidateProof {
  const proof = Object.freeze({ [verifiedCandidateProofBrand]: true as const });
  verifiedCandidateProofs.set(proof, { evidence, state: "available" });
  return proof;
}

export function readVerifiedCandidateProof(value: unknown): VerifiedCandidateEvidence {
  if (typeof value !== "object" || value === null) throw new CandidateApiError(400, "Candidate proof is malformed");
  const state = verifiedCandidateProofs.get(value as VerifiedCandidateProof);
  if (!state || state.state !== "available") throw new CandidateApiError(409, "Candidate proof is unavailable");
  return state.evidence;
}

export function claimVerifiedCandidateProof(value: unknown): Readonly<{
  evidence: VerifiedCandidateEvidence;
  settle: (committed: boolean) => void;
}> {
  if (typeof value !== "object" || value === null) throw new CandidateApiError(400, "Candidate proof is malformed");
  const proof = value as VerifiedCandidateProof;
  const state = verifiedCandidateProofs.get(proof);
  if (!state || state.state !== "available") throw new CandidateApiError(409, "Candidate proof is unavailable");
  state.state = "claimed";
  let settled = false;
  return Object.freeze({
    evidence: state.evidence,
    settle: (committed: boolean): void => {
      if (settled) return;
      settled = true;
      state.state = committed ? "consumed" : "available";
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateCandidateAttempt(value: unknown, serverAuthority: string): AcquisitionSessionAttempt {
  let attempt: ReturnType<typeof validateSessionAttempt>;
  try {
    attempt = validateSessionAttempt(value);
  } catch {
    throw new CandidateApiError(400, "Candidate attempt is malformed");
  }
  if (attempt.kind !== "acquisition") {
    throw new CandidateApiError(400, "Candidate attempt has another capability domain");
  }
  if (attempt.serverAuthority !== serverAuthority) {
    throw new CandidateApiError(409, "Candidate attempt belongs to another server authority");
  }
  if (attempt.expiresAt <= Date.now()) {
    throw new CandidateApiError(409, "Candidate attempt is missing or expired");
  }
  return attempt;
}

/**
 * Validate a token candidate against the pinned server without consulting or
 * mutating the active session. In particular, 401 has no refresh or logout
 * side effect: the caller destroys only its candidate attempt.
 */
export async function requestCandidateMe(input: CandidateMeRequest): Promise<CandidateMeResult> {
  if (input.signal.aborted) throw new DOMException("Candidate request was aborted", "AbortError");

  const serverAuthority = canonicalizeServerAuthority(input.serverAuthority);
  const attempt = validateCandidateAttempt(input.attempt, serverAuthority);
  const structurallyValidated = createCandidateTokenSnapshot({
    accessToken: input.candidate.accessToken,
    refreshToken: input.candidate.refreshToken,
  });
  const candidate = await fingerprintCandidateTokenSnapshot(structurallyValidated, serverAuthority);
  if (input.signal.aborted) throw new DOMException("Candidate request was aborted", "AbortError");
  if (
    input.candidate.credentialFingerprint !== undefined &&
    input.candidate.credentialFingerprint !== candidate.credentialFingerprint
  ) {
    throw new CandidateApiError(400, "Candidate fingerprint does not match its token bytes");
  }
  if (candidate.accessExpiresAt <= Date.now() || candidate.refreshExpiresAt <= Date.now()) {
    throw new CandidateApiError(401, "Candidate credential is expired");
  }

  const assertResponseCurrent = async (): Promise<void> => {
    await input.assertResponseCurrent();
    if (input.signal.aborted) throw new DOMException("Candidate request was aborted", "AbortError");
  };

  let response: Response;
  try {
    response = await input.dispatch(() =>
      fetch(`${BASE_URL}/me`, {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        redirect: "error",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${candidate.accessToken}`,
          ...expectedAuthorityHeaders(serverAuthority),
        },
        signal: input.signal,
      }),
    );
  } catch {
    await assertResponseCurrent();
    throw new CandidateApiError(503, "Candidate identity request is unavailable");
  }

  if (!response.ok) {
    await assertResponseCurrent();
    throw new CandidateApiError(response.status, `Candidate identity request failed (${response.status})`);
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    await assertResponseCurrent();
    throw new CandidateApiError(502, "Candidate identity response is malformed");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await readBoundedResponseText(response, MAX_ME_RESPONSE_BYTES));
  } catch {
    await assertResponseCurrent();
    throw new CandidateApiError(502, "Candidate identity response is malformed");
  }

  // A physically dispatched request may finish after logout, generation
  // rotation, or lease takeover. Its bytes stay quarantined until this gate.
  await assertResponseCurrent();

  if (!isRecord(payload) || !isRecord(payload.user) || typeof payload.user.id !== "string") {
    throw new CandidateApiError(502, "Candidate identity response is malformed");
  }
  if (payload.user.id !== candidate.accountIdCandidate) {
    throw new CandidateApiError(409, "Candidate identity does not match its token subject");
  }

  const evidence: VerifiedCandidateEvidence = Object.freeze({
    candidate,
    serverAuthority,
    accountId: payload.user.id,
    attempt,
  });
  return Object.freeze({
    accountId: payload.user.id,
    payload: Object.freeze(payload),
    proof: createVerifiedCandidateProof(evidence),
  });
}
