import { canonicalizeServerAuthority } from "../../api/server-authority.js";
import { SessionError, sessionErrorCodes } from "./errors.js";

const MAX_TOKEN_LENGTH = 64 * 1024;
const MAX_ACCOUNT_ID_LENGTH = 512;
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/u;
const FINGERPRINT_DOMAIN = "first-tree-browser-credential-fingerprint-v1";

type TokenKind = "access" | "refresh";

type StructuralJwtClaims = Readonly<{
  sub: string;
  type: TokenKind;
  exp: number;
}>;

export type CandidateTokenPairInput = Readonly<{
  accessToken: string;
  refreshToken: string;
}>;

/**
 * An immutable, structurally checked candidate. It is not an authenticated
 * session: only an explicit bearer request to the pinned server followed by a
 * matching `/me.user.id` can establish account authority.
 */
export type CandidateTokenSnapshot = Readonly<{
  accessToken: string;
  refreshToken: string;
  accountIdCandidate: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}>;

export type FingerprintedCandidateTokenSnapshot = CandidateTokenSnapshot &
  Readonly<{
    credentialFingerprint: string;
  }>;

function invalidCandidate(message: string, cause?: unknown): SessionError {
  return new SessionError(sessionErrorCodes.invalidState, message, cause);
}

function decodeBase64UrlSegment(value: string): Uint8Array {
  if (value.length === 0 || !BASE64URL_SEGMENT.test(value)) {
    throw invalidCandidate("Candidate token payload is not canonical base64url");
  }

  const remainder = value.length % 4;
  if (remainder === 1) throw invalidCandidate("Candidate token payload is malformed");
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/") + "=".repeat((4 - remainder) % 4);
  let decoded: string;
  try {
    decoded = atob(padded);
  } catch (error) {
    throw invalidCandidate("Candidate token payload is malformed", error);
  }
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeClaims(token: string, expectedKind: TokenKind): StructuralJwtClaims {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    throw invalidCandidate("Candidate token must be a non-empty bounded string");
  }
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
    throw invalidCandidate("Candidate token must be a compact JWT");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64UrlSegment(segments[1] ?? "")));
  } catch (error) {
    if (error instanceof SessionError) throw error;
    throw invalidCandidate("Candidate token payload is malformed", error);
  }
  if (!isRecord(payload)) throw invalidCandidate("Candidate token payload is malformed");

  const subject = payload.sub;
  const kind = payload.type;
  const expiresAtSeconds = payload.exp;
  if (typeof subject !== "string" || subject.length === 0 || subject.length > MAX_ACCOUNT_ID_LENGTH) {
    throw invalidCandidate("Candidate token subject is malformed");
  }
  if (kind !== expectedKind) throw invalidCandidate("Candidate token type is malformed");
  if (
    typeof expiresAtSeconds !== "number" ||
    !Number.isSafeInteger(expiresAtSeconds) ||
    expiresAtSeconds <= 0 ||
    expiresAtSeconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000)
  ) {
    throw invalidCandidate("Candidate token expiry is malformed");
  }

  return Object.freeze({ sub: subject, type: expectedKind, exp: expiresAtSeconds * 1000 });
}

/**
 * Decode only the non-authoritative JWT fields needed to reject inconsistent
 * pairs locally. Signature and account authority always come from the server.
 */
export function createCandidateTokenSnapshot(input: CandidateTokenPairInput): CandidateTokenSnapshot {
  const access = decodeClaims(input.accessToken, "access");
  const refresh = decodeClaims(input.refreshToken, "refresh");
  if (access.sub !== refresh.sub) throw invalidCandidate("Candidate token subjects do not match");

  return Object.freeze({
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    accountIdCandidate: access.sub,
    accessExpiresAt: access.exp,
    refreshExpiresAt: refresh.exp,
  });
}

function writeUint32(output: Uint8Array, offset: number, value: number): void {
  output[offset] = (value >>> 24) & 0xff;
  output[offset + 1] = (value >>> 16) & 0xff;
  output[offset + 2] = (value >>> 8) & 0xff;
  output[offset + 3] = value & 0xff;
}

/** Versioned framing avoids concatenation ambiguity in security fingerprints. */
export function encodeLengthFramedUtf8(values: readonly string[]): Uint8Array {
  const encoded = values.map((value) => new TextEncoder().encode(value));
  const byteLength = encoded.reduce((total, value) => total + 4 + value.byteLength, 0);
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const value of encoded) {
    if (value.byteLength > 0xffff_ffff) throw invalidCandidate("Fingerprint input exceeds the framing limit");
    writeUint32(output, offset, value.byteLength);
    offset += 4;
    output.set(value, offset);
    offset += value.byteLength;
  }
  return output;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/**
 * Compute before opening a coordinator transaction. No caller may digest or
 * await inside the transaction that compares/commits this fingerprint.
 */
export async function fingerprintCandidateTokenSnapshot(
  snapshot: CandidateTokenSnapshot,
  serverAuthority: string,
): Promise<FingerprintedCandidateTokenSnapshot> {
  if (!globalThis.crypto?.subtle) {
    throw new SessionError(sessionErrorCodes.platformUnavailable, "Web Crypto is required for authenticated sessions");
  }
  const authority = canonicalizeServerAuthority(serverAuthority);
  const framed = encodeLengthFramedUtf8([
    FINGERPRINT_DOMAIN,
    authority,
    snapshot.accountIdCandidate,
    snapshot.accessToken,
    snapshot.refreshToken,
  ]);
  const digestInput = new Uint8Array(framed.byteLength);
  digestInput.set(framed);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", digestInput.buffer));
  return Object.freeze({ ...snapshot, credentialFingerprint: encodeBase64Url(digest) });
}
