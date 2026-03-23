import { describe, expect, it } from "vitest";
import { decryptCredentials, encryptCredentials } from "../services/crypto.js";

const TEST_KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
// Same 32 bytes encoded as base64url
const TEST_KEY_B64 = Buffer.from(TEST_KEY_HEX, "hex").toString("base64url");

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
