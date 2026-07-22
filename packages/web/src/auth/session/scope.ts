import { canonicalizeServerAuthority } from "../../api/server-authority.js";
import { SessionError, sessionErrorCodes } from "./errors.js";

const SCOPE_KEY_PREFIX = "v1.";
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const MAX_SERVER_AUTHORITY_LENGTH = 2048;
const MAX_ACCOUNT_ID_LENGTH = 512;
const LOGICAL_DATABASE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export type AccountScope = Readonly<{
  serverAuthority: string;
  accountId: string;
}>;

function requireBoundedIdentity(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new SessionError(sessionErrorCodes.invalidState, `${label} must be a non-empty bounded string`);
  }
  return value;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let output = "";
  let accumulator = 0;
  let bits = 0;

  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      output += BASE64URL_ALPHABET[(accumulator >> bits) & 63];
    }
  }

  if (bits > 0) output += BASE64URL_ALPHABET[(accumulator << (6 - bits)) & 63];
  return output;
}

function decodeBase64Url(value: string): Uint8Array {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new SessionError(sessionErrorCodes.invalidState, "Account scope key is not canonical base64url");
  }

  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const character of value) {
    const index = BASE64URL_ALPHABET.indexOf(character);
    if (index < 0) {
      throw new SessionError(sessionErrorCodes.invalidState, "Account scope key contains invalid base64url bytes");
    }
    accumulator = (accumulator << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 255);
    }
  }

  if (bits > 0 && (accumulator & ((1 << bits) - 1)) !== 0) {
    throw new SessionError(sessionErrorCodes.invalidState, "Account scope key has non-canonical trailing bits");
  }
  return new Uint8Array(bytes);
}

export function createAccountScopeKey(serverAuthority: string, accountId: string): string {
  const providedAuthority = requireBoundedIdentity(serverAuthority, "Server authority", MAX_SERVER_AUTHORITY_LENGTH);
  let authority: string;
  try {
    authority = canonicalizeServerAuthority(providedAuthority);
  } catch (error) {
    throw new SessionError(sessionErrorCodes.invalidState, "Server authority is not canonical", error);
  }
  const account = requireBoundedIdentity(accountId, "Account id", MAX_ACCOUNT_ID_LENGTH);
  const canonicalTuple = JSON.stringify([authority, account]);
  return `${SCOPE_KEY_PREFIX}${encodeBase64Url(new TextEncoder().encode(canonicalTuple))}`;
}

export function parseAccountScopeKey(scopeKey: string): AccountScope {
  if (!scopeKey.startsWith(SCOPE_KEY_PREFIX)) {
    throw new SessionError(sessionErrorCodes.invalidState, "Account scope key has an unsupported version");
  }

  let decoded: unknown;
  try {
    const bytes = decodeBase64Url(scopeKey.slice(SCOPE_KEY_PREFIX.length));
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new SessionError(sessionErrorCodes.invalidState, "Account scope key cannot be decoded", error);
  }

  if (
    !Array.isArray(decoded) ||
    decoded.length !== 2 ||
    typeof decoded[0] !== "string" ||
    typeof decoded[1] !== "string"
  ) {
    throw new SessionError(sessionErrorCodes.invalidState, "Account scope key payload is malformed");
  }

  const serverAuthority = requireBoundedIdentity(decoded[0], "Server authority", MAX_SERVER_AUTHORITY_LENGTH);
  const accountId = requireBoundedIdentity(decoded[1], "Account id", MAX_ACCOUNT_ID_LENGTH);
  if (createAccountScopeKey(serverAuthority, accountId) !== scopeKey) {
    throw new SessionError(sessionErrorCodes.invalidState, "Account scope key is not canonical");
  }
  return Object.freeze({ serverAuthority, accountId });
}

export function createScopedDatabaseName(logicalName: string, namespaceVersion: number, scopeKey: string): string {
  if (!LOGICAL_DATABASE_NAME.test(logicalName)) {
    throw new SessionError(sessionErrorCodes.invalidState, "Logical database name is not canonical");
  }
  if (!Number.isSafeInteger(namespaceVersion) || namespaceVersion < 1) {
    throw new SessionError(sessionErrorCodes.invalidState, "Database namespace version must be a positive integer");
  }
  parseAccountScopeKey(scopeKey);
  return `${logicalName}:v${namespaceVersion}:${scopeKey}`;
}

export function isDatabaseNameForScope(databaseName: string, scopeKey: string): boolean {
  parseAccountScopeKey(scopeKey);
  const scopeSuffix = `:${scopeKey}`;
  if (!databaseName.endsWith(scopeSuffix)) return false;
  const namespacedPrefix = databaseName.slice(0, -scopeSuffix.length);
  const marker = namespacedPrefix.lastIndexOf(":v");
  if (marker <= 0) return false;
  const logicalName = namespacedPrefix.slice(0, marker);
  const namespaceVersion = namespacedPrefix.slice(marker + 2);
  if (!LOGICAL_DATABASE_NAME.test(logicalName) || !/^[1-9]\d*$/.test(namespaceVersion)) return false;
  const parsedVersion = Number(namespaceVersion);
  return Number.isSafeInteger(parsedVersion);
}
