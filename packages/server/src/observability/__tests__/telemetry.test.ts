import { describe, expect, it } from "vitest";
import { normalizeAttrs, parseHeaderString } from "../telemetry.js";

describe("normalizeAttrs", () => {
  describe("sensitive key redaction", () => {
    it("redacts exact-match sensitive keys", () => {
      const out = normalizeAttrs({
        password: "hunter2",
        token: "abc",
        secret: "xyz",
        apiKey: "key",
      });
      expect(out).toEqual({
        password: "***",
        token: "***",
        secret: "***",
        apiKey: "***",
      });
    });

    it("redacts regardless of key casing", () => {
      const out = normalizeAttrs({
        Authorization: "Bearer xxx",
        AUTHORIZATION: "Bearer yyy",
        authorization: "Bearer zzz",
      });
      expect(out).toEqual({
        Authorization: "***",
        AUTHORIZATION: "***",
        authorization: "***",
      });
    });

    it("redacts keys where sensitive pattern is a substring", () => {
      const out = normalizeAttrs({
        userToken: "abc",
        jwtSecret: "sign-key",
        dbPassword: "pg",
        encryptionKey: "aes",
      });
      expect(out.userToken).toBe("***");
      expect(out.jwtSecret).toBe("***");
      expect(out.dbPassword).toBe("***");
      expect(out.encryptionKey).toBe("***");
    });

    it("does not redact benign keys that happen to look similar", () => {
      const out = normalizeAttrs({
        userId: "u123",
        messageId: "m456",
        "chat.id": "c789",
      });
      expect(out).toEqual({ userId: "u123", messageId: "m456", "chat.id": "c789" });
    });
  });

  describe("type coercion", () => {
    it("passes strings, numbers, booleans through", () => {
      expect(normalizeAttrs({ s: "hi", n: 42, b: true })).toEqual({ s: "hi", n: 42, b: true });
    });

    it("preserves arrays of strings as arrays (OTel supports)", () => {
      expect(normalizeAttrs({ tags: ["a", "b", "c"] })).toEqual({ tags: ["a", "b", "c"] });
    });

    it("JSON-stringifies objects and mixed arrays", () => {
      const out = normalizeAttrs({
        obj: { a: 1, b: "two" },
        mixed: [1, "two", true],
      });
      expect(out.obj).toBe('{"a":1,"b":"two"}');
      expect(out.mixed).toBe('[1,"two",true]');
    });

    it("drops null and undefined values", () => {
      const out = normalizeAttrs({ keep: "yes", skip: null, gone: undefined });
      expect(out).toEqual({ keep: "yes" });
    });

    it("returns empty object when input is undefined", () => {
      expect(normalizeAttrs(undefined)).toEqual({});
    });

    it("falls back to String() when JSON.stringify throws", () => {
      const circular: Record<string, unknown> = { name: "loop" };
      circular.self = circular;
      const out = normalizeAttrs({ circular });
      expect(typeof out.circular).toBe("string");
      // We don't care about the exact string — just that it didn't crash and produced something.
      expect(out.circular).toBeTruthy();
    });
  });
});

describe("parseHeaderString", () => {
  it("returns an empty object for empty input", () => {
    expect(parseHeaderString("")).toEqual({});
  });

  it("parses simple key=value pairs", () => {
    expect(parseHeaderString("a=1,b=2")).toEqual({ a: "1", b: "2" });
  });

  it("preserves values containing '=' (e.g. base64 padding)", () => {
    const out = parseHeaderString("Authorization=Bearer abc==def");
    expect(out).toEqual({ Authorization: "Bearer abc==def" });
  });

  it("trims whitespace around keys and values", () => {
    expect(parseHeaderString("  a = 1 ,  b=2  ")).toEqual({ a: "1", b: "2" });
  });

  it("skips empty pairs and fragments without '='", () => {
    expect(parseHeaderString("a=1,,b=2,invalid,c=3")).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("skips fragments that start with '=' (no key)", () => {
    expect(parseHeaderString("=nope,a=1")).toEqual({ a: "1" });
  });

  it("handles realistic Logfire-style token header", () => {
    const out = parseHeaderString("Authorization=Bearer pylf_v1_us_xyzABC123==");
    expect(out).toEqual({ Authorization: "Bearer pylf_v1_us_xyzABC123==" });
  });
});
