import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const BOUND_PAYLOAD_PREFIX = "enc:bound:v1:";
const BOUND_PAYLOAD_AAD_PURPOSE = "first-tree.bound-payload";
const BOUND_PAYLOAD_AAD_VERSION = "v1";
const LENGTH_FRAME_BYTES = 4;
const MAX_BOUND_PAYLOAD_PLAINTEXT_BYTES = 1024 * 1024;
const MAX_BOUND_PAYLOAD_BYTES = IV_LENGTH + AUTH_TAG_LENGTH + MAX_BOUND_PAYLOAD_PLAINTEXT_BYTES;
const MAX_BOUND_PAYLOAD_ENCODED_LENGTH = Math.ceil((MAX_BOUND_PAYLOAD_BYTES * 4) / 3);
const MAX_BOUND_CONTEXT_FIELDS = 32;
const MAX_BOUND_CONTEXT_DOMAIN_BYTES = 128;
const MAX_BOUND_CONTEXT_FIELD_NAME_BYTES = 128;
const MAX_BOUND_CONTEXT_FIELD_VALUE_BYTES = 4 * 1024;
const MAX_BOUND_CONTEXT_AAD_BYTES = 16 * 1024;

export type BoundPayloadContext = Readonly<{
  domain: string;
  fields: readonly Readonly<{
    name: string;
    value: string;
  }>[];
}>;

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
  throw new Error("Encryption key must be 32 bytes, encoded as hex (64 chars) or base64url (43 chars)");
}

export function assertEncryptionKeyValid(encoded: string): void {
  parseKey(encoded);
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

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function encodeBoundPayloadFrame(value: string, label: string, maxBytes: number): Buffer {
  if (value.length > maxBytes) {
    throw new RangeError(`${label} exceeds ${maxBytes} UTF-8 bytes`);
  }
  if (!isWellFormedUtf16(value)) {
    throw new TypeError(`${label} must contain well-formed UTF-16`);
  }
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > maxBytes) {
    throw new RangeError(`${label} exceeds ${maxBytes} UTF-8 bytes`);
  }
  const frame = Buffer.alloc(LENGTH_FRAME_BYTES + bytes.length);
  frame.writeUInt32BE(bytes.length, 0);
  bytes.copy(frame, LENGTH_FRAME_BYTES);
  return frame;
}

function buildBoundPayloadAad(context: BoundPayloadContext): Buffer {
  if (typeof context !== "object" || context === null) {
    throw new TypeError("Bound payload context must be an object");
  }
  const domain = context.domain;
  const fields = context.fields;
  if (typeof domain !== "string" || domain.length === 0) {
    throw new TypeError("Bound payload context domain must be a non-empty string");
  }
  if (!Array.isArray(fields)) {
    throw new TypeError("Bound payload context fields must be an array");
  }
  if (fields.length > MAX_BOUND_CONTEXT_FIELDS) {
    throw new RangeError(`Bound payload context cannot exceed ${MAX_BOUND_CONTEXT_FIELDS} fields`);
  }

  const frames: Buffer[] = [];
  let totalLength = 0;
  const addFrame = (frame: Buffer): void => {
    totalLength += frame.length;
    if (totalLength > MAX_BOUND_CONTEXT_AAD_BYTES) {
      throw new RangeError(`Bound payload context exceeds ${MAX_BOUND_CONTEXT_AAD_BYTES} encoded bytes`);
    }
    frames.push(frame);
  };
  addFrame(
    encodeBoundPayloadFrame(
      BOUND_PAYLOAD_AAD_PURPOSE,
      "Bound payload AAD purpose",
      Buffer.byteLength(BOUND_PAYLOAD_AAD_PURPOSE),
    ),
  );
  addFrame(
    encodeBoundPayloadFrame(
      BOUND_PAYLOAD_AAD_VERSION,
      "Bound payload AAD version",
      Buffer.byteLength(BOUND_PAYLOAD_AAD_VERSION),
    ),
  );
  addFrame(encodeBoundPayloadFrame(domain, "Bound payload context domain", MAX_BOUND_CONTEXT_DOMAIN_BYTES));
  const fieldCount = Buffer.alloc(LENGTH_FRAME_BYTES);
  fieldCount.writeUInt32BE(fields.length, 0);
  addFrame(fieldCount);

  const fieldNames = new Set<string>();
  for (const field of fields) {
    if (typeof field !== "object" || field === null) {
      throw new TypeError("Bound payload context fields must be objects");
    }
    const name = field.name;
    const value = field.value;
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError("Bound payload context field names must be non-empty strings");
    }
    if (typeof value !== "string") {
      throw new TypeError("Bound payload context field values must be strings");
    }
    if (fieldNames.has(name)) {
      throw new TypeError(`Duplicate bound payload context field name: ${name}`);
    }
    fieldNames.add(name);
    addFrame(encodeBoundPayloadFrame(name, "Bound payload context field name", MAX_BOUND_CONTEXT_FIELD_NAME_BYTES));
    addFrame(encodeBoundPayloadFrame(value, "Bound payload context field value", MAX_BOUND_CONTEXT_FIELD_VALUE_BYTES));
  }

  return Buffer.concat(frames, totalLength);
}

function serializeBoundPayload(data: unknown): Buffer {
  const serialized = JSON.stringify(data);
  if (serialized === undefined) {
    throw new TypeError("Bound payload must be JSON-serializable");
  }
  if (serialized.length > MAX_BOUND_PAYLOAD_PLAINTEXT_BYTES) {
    throw new RangeError(`Bound payload plaintext exceeds ${MAX_BOUND_PAYLOAD_PLAINTEXT_BYTES} bytes`);
  }
  const plaintext = Buffer.from(serialized, "utf8");
  if (plaintext.length > MAX_BOUND_PAYLOAD_PLAINTEXT_BYTES) {
    throw new RangeError(`Bound payload plaintext exceeds ${MAX_BOUND_PAYLOAD_PLAINTEXT_BYTES} bytes`);
  }
  return plaintext;
}

function decodeBoundPayload(ciphertext: string): Buffer {
  if (typeof ciphertext !== "string" || !ciphertext.startsWith(BOUND_PAYLOAD_PREFIX)) {
    throw new Error("Unsupported bound payload format");
  }
  if (
    ciphertext.length <= BOUND_PAYLOAD_PREFIX.length ||
    ciphertext.length > BOUND_PAYLOAD_PREFIX.length + MAX_BOUND_PAYLOAD_ENCODED_LENGTH
  ) {
    throw new RangeError("Bound payload ciphertext has an invalid length");
  }
  const encoded = ciphertext.slice(BOUND_PAYLOAD_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("Bound payload ciphertext must be canonical base64url");
  }
  const combined = Buffer.from(encoded, "base64url");
  if (combined.toString("base64url") !== encoded) {
    throw new Error("Bound payload ciphertext must be canonical base64url");
  }
  if (combined.length <= IV_LENGTH + AUTH_TAG_LENGTH || combined.length > MAX_BOUND_PAYLOAD_BYTES) {
    throw new RangeError("Bound payload ciphertext has an invalid length");
  }
  return combined;
}

/**
 * Encrypt a JSON-serializable value and bind it to an explicit domain and
 * ordered context. The context is authenticated as versioned, length-framed
 * UTF-8 associated data and is not included in the returned ciphertext.
 */
export function encryptBoundPayload(data: unknown, keyEncoded: string, context: BoundPayloadContext): string {
  const key = parseKey(keyEncoded);
  const aad = buildBoundPayloadAad(context);
  const plaintext = serializeBoundPayload(data);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const combined = Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  return `${BOUND_PAYLOAD_PREFIX}${combined.toString("base64url")}`;
}

/**
 * Decrypt a bound JSON payload. Authentication fails if its key, domain,
 * ordered context, version, or ciphertext differs from the encryption inputs.
 */
export function decryptBoundPayload(ciphertext: string, keyEncoded: string, context: BoundPayloadContext): unknown {
  const key = parseKey(keyEncoded);
  const aad = buildBoundPayloadAad(context);
  const combined = decodeBoundPayload(ciphertext);
  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);
  let decrypted: Buffer;
  try {
    decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch (cause) {
    throw new Error("Bound payload authentication failed", { cause });
  }
  if (decrypted.length > MAX_BOUND_PAYLOAD_PLAINTEXT_BYTES) {
    throw new RangeError("Bound payload plaintext exceeds the supported size");
  }
  const plaintext = new TextDecoder("utf-8", { fatal: true }).decode(decrypted);
  return JSON.parse(plaintext) as unknown;
}

/** Marker prefix that lets `decryptValue` distinguish ciphertext from plaintext. */
const VALUE_CIPHER_PREFIX = "enc:v1:";

/**
 * Encrypt a single string value with AES-256-GCM (field-level, not whole-object).
 * Used for sensitive env entries inside agent runtime config.
 */
export function encryptValue(plain: string, keyEncoded: string): string {
  const key = parseKey(keyEncoded);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, authTag, encrypted]);
  return `${VALUE_CIPHER_PREFIX}${combined.toString("base64")}`;
}

/**
 * Decrypt a value previously produced by `encryptValue`. Returns `cipher`
 * unchanged if it is missing the cipher prefix — useful for graceful
 * coexistence with plaintext values during initial backfill.
 */
export function decryptValue(cipher: string, keyEncoded: string): string {
  if (!cipher.startsWith(VALUE_CIPHER_PREFIX)) return cipher;
  const key = parseKey(keyEncoded);
  const combined = Buffer.from(cipher.slice(VALUE_CIPHER_PREFIX.length), "base64");
  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

export function isEncryptedValue(s: string): boolean {
  return s.startsWith(VALUE_CIPHER_PREFIX);
}
