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

export type CandidateMeResult = Readonly<{
  accountId: string;
  payload: Readonly<Record<string, unknown>>;
  candidate: FingerprintedCandidateTokenSnapshot;
  attempt: CandidateAttemptBinding;
  serverAuthority: string;
}>;

export type CandidateAttemptBinding = AcquisitionSessionAttempt;

export type CandidateMeRequest = Readonly<{
  candidate: CandidateTokenPairInput & Partial<Pick<FingerprintedCandidateTokenSnapshot, "credentialFingerprint">>;
  attempt: CandidateAttemptBinding;
  serverAuthority: string;
  signal: AbortSignal;
}>;

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
  const signal = input.signal;
  const serverAuthorityValue = input.serverAuthority;
  const attemptValue = input.attempt;
  const accessToken = input.candidate.accessToken;
  const refreshToken = input.candidate.refreshToken;
  const suppliedFingerprint = input.candidate.credentialFingerprint;
  if (signal.aborted) throw new DOMException("Candidate request was aborted", "AbortError");

  const serverAuthority = canonicalizeServerAuthority(serverAuthorityValue);
  const attempt = validateCandidateAttempt(attemptValue, serverAuthority);
  const structurallyValidated = createCandidateTokenSnapshot({
    accessToken,
    refreshToken,
  });
  const candidate = await fingerprintCandidateTokenSnapshot(structurallyValidated, serverAuthority);
  if (signal.aborted) throw new DOMException("Candidate request was aborted", "AbortError");
  if (suppliedFingerprint !== undefined && suppliedFingerprint !== candidate.credentialFingerprint) {
    throw new CandidateApiError(400, "Candidate fingerprint does not match its token bytes");
  }
  if (candidate.accessExpiresAt <= Date.now() || candidate.refreshExpiresAt <= Date.now()) {
    throw new CandidateApiError(401, "Candidate credential is expired");
  }

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/me`, {
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
      signal,
    });
  } catch {
    if (signal.aborted) throw new DOMException("Candidate request was aborted", "AbortError");
    throw new CandidateApiError(503, "Candidate identity request is unavailable");
  }

  if (!response.ok) {
    if (signal.aborted) throw new DOMException("Candidate request was aborted", "AbortError");
    throw new CandidateApiError(response.status, `Candidate identity request failed (${response.status})`);
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    if (signal.aborted) throw new DOMException("Candidate request was aborted", "AbortError");
    throw new CandidateApiError(502, "Candidate identity response is malformed");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await readBoundedResponseText(response, MAX_ME_RESPONSE_BYTES));
  } catch {
    if (signal.aborted) throw new DOMException("Candidate request was aborted", "AbortError");
    throw new CandidateApiError(502, "Candidate identity response is malformed");
  }

  if (signal.aborted) throw new DOMException("Candidate request was aborted", "AbortError");

  if (!isRecord(payload) || !isRecord(payload.user) || typeof payload.user.id !== "string") {
    throw new CandidateApiError(502, "Candidate identity response is malformed");
  }
  if (payload.user.id !== candidate.accountIdCandidate) {
    throw new CandidateApiError(409, "Candidate identity does not match its token subject");
  }

  return Object.freeze({
    accountId: payload.user.id,
    payload: Object.freeze(payload),
    candidate,
    attempt,
    serverAuthority,
  });
}
