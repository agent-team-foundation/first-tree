import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Parse a 32-byte key from either hex (64 chars) or base64url (43 chars) encoding.
 */
function parseKey(encoded: string): Buffer {
  // Try hex first (64 hex chars = 32 bytes)
  if (/^[0-9a-f]{64}$/i.test(encoded)) {
    return Buffer.from(encoded, "hex");
  }
  // Try base64url (43 chars + optional padding = 32 bytes)
  const buf = Buffer.from(encoded, "base64url");
  if (buf.length === 32) {
    return buf;
  }
  throw new Error("ADAPTER_ENCRYPTION_KEY must be 32 bytes, encoded as hex (64 chars) or base64url (43 chars)");
}

/**
 * Encrypt a JSON-serializable value using AES-256-GCM.
 * Returns a base64 string containing: IV (12 bytes) + auth tag (16 bytes) + ciphertext.
 */
export function encryptCredentials(data: unknown, keyEncoded: string): string {
  const key = parseKey(keyEncoded);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = JSON.stringify(data);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, authTag, encrypted]);
  return combined.toString("base64");
}

/**
 * Decrypt a base64-encoded AES-256-GCM ciphertext back to the original value.
 */
export function decryptCredentials(encryptedBase64: string, keyEncoded: string): unknown {
  const key = parseKey(keyEncoded);
  const combined = Buffer.from(encryptedBase64, "base64");
  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8")) as unknown;
}
