import { describe, expect, it } from "vitest";
import {
  type BoundPayloadContext,
  decryptBoundPayload,
  decryptCredentials,
  encryptBoundPayload,
  encryptCredentials,
} from "../services/crypto.js";

const TEST_KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
// Same 32 bytes encoded as base64url
const TEST_KEY_B64 = Buffer.from(TEST_KEY_HEX, "hex").toString("base64url");
const OTHER_TEST_KEY_HEX = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOUND_PAYLOAD_PREFIX = "enc:bound:v1:";
const BOUND_PAYLOAD_CONTEXT = {
  domain: "oauth.browser-storage-key",
  fields: [
    { name: "serverOrigin", value: "https://first-tree.example" },
    { name: "userId", value: "user-123" },
  ],
} as const satisfies BoundPayloadContext;

describe("Credential encryption", () => {
  it("encrypts and decrypts round-trip with hex key", () => {
    const data = { app_id: "cli_xxx", app_secret: "secret123" };
    const encrypted = encryptCredentials(data, TEST_KEY_HEX);
    expect(typeof encrypted).toBe("string");
    const decrypted = decryptCredentials(encrypted, TEST_KEY_HEX);
    expect(decrypted).toEqual(data);
  });

  it("encrypts and decrypts round-trip with base64url key", () => {
    const data = { app_id: "cli_xxx", app_secret: "secret123" };
    const encrypted = encryptCredentials(data, TEST_KEY_B64);
    const decrypted = decryptCredentials(encrypted, TEST_KEY_B64);
    expect(decrypted).toEqual(data);
  });

  it("hex and base64url keys are interchangeable (same 32 bytes)", () => {
    const data = { cross: "format" };
    const encrypted = encryptCredentials(data, TEST_KEY_HEX);
    const decrypted = decryptCredentials(encrypted, TEST_KEY_B64);
    expect(decrypted).toEqual(data);
  });

  it("produces different ciphertext for same plaintext (random IV)", () => {
    const data = { key: "value" };
    const a = encryptCredentials(data, TEST_KEY_HEX);
    const b = encryptCredentials(data, TEST_KEY_HEX);
    expect(a).not.toBe(b);
  });

  it("throws on wrong key", () => {
    const data = { key: "value" };
    const encrypted = encryptCredentials(data, TEST_KEY_HEX);
    const wrongKey = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(() => decryptCredentials(encrypted, wrongKey)).toThrow();
  });

  it("throws on invalid key length", () => {
    expect(() => encryptCredentials({}, "short")).toThrow();
  });

  it("handles complex nested JSON", () => {
    const data = {
      nested: { deep: { value: [1, 2, 3] } },
      unicode: "你好世界",
      special: "key=val&foo=bar",
    };
    const encrypted = encryptCredentials(data, TEST_KEY_HEX);
    expect(decryptCredentials(encrypted, TEST_KEY_HEX)).toEqual(data);
  });

  it("throws on corrupted ciphertext", () => {
    const encrypted = encryptCredentials({ key: "value" }, TEST_KEY_HEX);
    const corrupted = `${encrypted.slice(0, -4)}XXXX`;
    expect(() => decryptCredentials(corrupted, TEST_KEY_HEX)).toThrow();
  });

  it("rejects hex string with wrong length (not 64 chars)", () => {
    // 32 hex chars = only 16 bytes, not 32
    expect(() => encryptCredentials({}, "0123456789abcdef0123456789abcdef")).toThrow();
  });
});

describe("Bound payload encryption", () => {
  it("round-trips JSON with either encoding of the same key", () => {
    const data = {
      nested: { array: [1, true, null] },
      unicode: "账号 🔐",
    };
    const encrypted = encryptBoundPayload(data, TEST_KEY_HEX, BOUND_PAYLOAD_CONTEXT);

    expect(encrypted).toMatch(/^enc:bound:v1:[A-Za-z0-9_-]+$/);
    expect(decryptBoundPayload(encrypted, TEST_KEY_B64, BOUND_PAYLOAD_CONTEXT)).toEqual(data);
  });

  it("uses a fresh 12-byte IV and a 16-byte authentication tag", () => {
    const data = { key: "value" };
    const first = encryptBoundPayload(data, TEST_KEY_HEX, BOUND_PAYLOAD_CONTEXT);
    const second = encryptBoundPayload(data, TEST_KEY_HEX, BOUND_PAYLOAD_CONTEXT);
    const firstBytes = Buffer.from(first.slice(BOUND_PAYLOAD_PREFIX.length), "base64url");
    const secondBytes = Buffer.from(second.slice(BOUND_PAYLOAD_PREFIX.length), "base64url");
    const plaintextLength = Buffer.byteLength(JSON.stringify(data));

    expect(firstBytes).toHaveLength(12 + 16 + plaintextLength);
    expect(secondBytes).toHaveLength(12 + 16 + plaintextLength);
    expect(firstBytes.subarray(0, 12)).not.toEqual(secondBytes.subarray(0, 12));
    expect(first).not.toBe(second);
  });

  it("authenticates the domain and every ordered context field", () => {
    const encrypted = encryptBoundPayload({ secret: true }, TEST_KEY_HEX, BOUND_PAYLOAD_CONTEXT);
    const mismatches: BoundPayloadContext[] = [
      { ...BOUND_PAYLOAD_CONTEXT, domain: "oauth.other-domain" },
      {
        ...BOUND_PAYLOAD_CONTEXT,
        fields: [{ name: "origin", value: BOUND_PAYLOAD_CONTEXT.fields[0].value }, BOUND_PAYLOAD_CONTEXT.fields[1]],
      },
      {
        ...BOUND_PAYLOAD_CONTEXT,
        fields: [BOUND_PAYLOAD_CONTEXT.fields[0], { name: "userId", value: "user-456" }],
      },
      {
        ...BOUND_PAYLOAD_CONTEXT,
        fields: [...BOUND_PAYLOAD_CONTEXT.fields].reverse(),
      },
    ];

    for (const mismatch of mismatches) {
      expect(() => decryptBoundPayload(encrypted, TEST_KEY_HEX, mismatch)).toThrow(
        "Bound payload authentication failed",
      );
    }
  });

  it("length-frames field names and values without concatenation ambiguity", () => {
    const encryptionContext: BoundPayloadContext = {
      domain: "test",
      fields: [{ name: "ab", value: "c" }],
    };
    const ambiguousWithoutFrames: BoundPayloadContext = {
      domain: "test",
      fields: [{ name: "a", value: "bc" }],
    };
    const encrypted = encryptBoundPayload("secret", TEST_KEY_HEX, encryptionContext);

    expect(() => decryptBoundPayload(encrypted, TEST_KEY_HEX, ambiguousWithoutFrames)).toThrow(
      "Bound payload authentication failed",
    );
  });

  it("rejects a wrong key", () => {
    const encrypted = encryptBoundPayload({ secret: true }, TEST_KEY_HEX, BOUND_PAYLOAD_CONTEXT);

    expect(() => decryptBoundPayload(encrypted, OTHER_TEST_KEY_HEX, BOUND_PAYLOAD_CONTEXT)).toThrow(
      "Bound payload authentication failed",
    );
  });

  it.each([
    ["IV", 0],
    ["authentication tag", 12],
    ["ciphertext", -1],
  ])("rejects a modified %s byte", (_component, byteIndex) => {
    const encrypted = encryptBoundPayload({ secret: true }, TEST_KEY_HEX, BOUND_PAYLOAD_CONTEXT);
    const combined = Buffer.from(encrypted.slice(BOUND_PAYLOAD_PREFIX.length), "base64url");
    const index = byteIndex < 0 ? combined.length - 1 : byteIndex;
    combined[index] = (combined[index] ?? 0) ^ 1;
    const tampered = `${BOUND_PAYLOAD_PREFIX}${combined.toString("base64url")}`;

    expect(() => decryptBoundPayload(tampered, TEST_KEY_HEX, BOUND_PAYLOAD_CONTEXT)).toThrow(
      "Bound payload authentication failed",
    );
  });

  it("rejects unsupported versions, malformed encoding, and truncated payloads", () => {
    const encrypted = encryptBoundPayload({ secret: true }, TEST_KEY_HEX, BOUND_PAYLOAD_CONTEXT);

    expect(() =>
      decryptBoundPayload(
        encrypted.replace(BOUND_PAYLOAD_PREFIX, "enc:bound:v2:"),
        TEST_KEY_HEX,
        BOUND_PAYLOAD_CONTEXT,
      ),
    ).toThrow("Unsupported bound payload format");
    expect(() => decryptBoundPayload("enc:bound:v1:not+base64", TEST_KEY_HEX, BOUND_PAYLOAD_CONTEXT)).toThrow(
      "canonical base64url",
    );
    expect(() => decryptBoundPayload(`${encrypted}=`, TEST_KEY_HEX, BOUND_PAYLOAD_CONTEXT)).toThrow(
      "canonical base64url",
    );
    expect(() => decryptBoundPayload("enc:bound:v1:AAAA", TEST_KEY_HEX, BOUND_PAYLOAD_CONTEXT)).toThrow(
      "invalid length",
    );
  });

  it("validates domain and field structure before encryption", () => {
    expect(() => encryptBoundPayload(null, TEST_KEY_HEX, { domain: "", fields: [] })).toThrow(
      "domain must be a non-empty string",
    );
    expect(() =>
      encryptBoundPayload(null, TEST_KEY_HEX, {
        domain: "test",
        fields: [{ name: "", value: "value" }],
      }),
    ).toThrow("field names must be non-empty strings");
    expect(() =>
      encryptBoundPayload(null, TEST_KEY_HEX, {
        domain: "test",
        fields: [
          { name: "userId", value: "one" },
          { name: "userId", value: "two" },
        ],
      }),
    ).toThrow("Duplicate bound payload context field name");
  });

  it("bounds individual context components, count, and aggregate AAD size", () => {
    expect(() => encryptBoundPayload(null, TEST_KEY_HEX, { domain: "é".repeat(64), fields: [] })).not.toThrow();
    expect(() => encryptBoundPayload(null, TEST_KEY_HEX, { domain: "é".repeat(65), fields: [] })).toThrow(
      "domain exceeds 128 UTF-8 bytes",
    );
    expect(() => encryptBoundPayload(null, TEST_KEY_HEX, { domain: "d".repeat(129), fields: [] })).toThrow(
      "domain exceeds 128 UTF-8 bytes",
    );
    expect(() =>
      encryptBoundPayload(null, TEST_KEY_HEX, {
        domain: "test",
        fields: [{ name: "n".repeat(129), value: "" }],
      }),
    ).toThrow("field name exceeds 128 UTF-8 bytes");
    expect(() =>
      encryptBoundPayload(null, TEST_KEY_HEX, {
        domain: "test",
        fields: [{ name: "value", value: "v".repeat(4097) }],
      }),
    ).toThrow("field value exceeds 4096 UTF-8 bytes");
    expect(() =>
      encryptBoundPayload(null, TEST_KEY_HEX, {
        domain: "test",
        fields: Array.from({ length: 33 }, (_, index) => ({
          name: `field-${index}`,
          value: "",
        })),
      }),
    ).toThrow("cannot exceed 32 fields");
    expect(() =>
      encryptBoundPayload(null, TEST_KEY_HEX, {
        domain: "test",
        fields: Array.from({ length: 4 }, (_, index) => ({
          name: `field-${index}`,
          value: "v".repeat(4096),
        })),
      }),
    ).toThrow("context exceeds 16384 encoded bytes");
  });

  it("rejects ambiguous malformed UTF-16 context strings", () => {
    expect(() =>
      encryptBoundPayload(null, TEST_KEY_HEX, {
        domain: "test",
        fields: [{ name: "value", value: "\ud800" }],
      }),
    ).toThrow("well-formed UTF-16");
  });

  it("bounds plaintext and encoded ciphertext before cryptographic work", () => {
    expect(() => encryptBoundPayload("x".repeat(1024 * 1024), TEST_KEY_HEX, BOUND_PAYLOAD_CONTEXT)).toThrow(
      "plaintext exceeds 1048576 bytes",
    );
    expect(() =>
      decryptBoundPayload(
        `${BOUND_PAYLOAD_PREFIX}${"A".repeat(Math.ceil(((1024 * 1024 + 28) * 4) / 3) + 1)}`,
        TEST_KEY_HEX,
        BOUND_PAYLOAD_CONTEXT,
      ),
    ).toThrow("invalid length");
  });

  it("rejects values that JSON cannot serialize at the root", () => {
    expect(() => encryptBoundPayload(undefined, TEST_KEY_HEX, BOUND_PAYLOAD_CONTEXT)).toThrow(
      "must be JSON-serializable",
    );
  });

  it("uses the existing strict 32-byte key parser", () => {
    expect(() => encryptBoundPayload(null, "short", BOUND_PAYLOAD_CONTEXT)).toThrow("Encryption key must be 32 bytes");
  });
});
