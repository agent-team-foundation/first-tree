import { afterEach, describe, expect, it } from "vitest";
import {
  initTelemetry,
  isTelemetryEnabled,
  normalizeAttrs,
  parseHeaderString,
  shutdownTelemetry,
} from "../telemetry.js";

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

describe("initTelemetry / shutdownTelemetry lifecycle", () => {
  afterEach(async () => {
    // Make sure each test starts from a clean slate regardless of what the
    // previous one left behind.
    await shutdownTelemetry();
  });

  it("stays disabled when endpoint is empty", async () => {
    await initTelemetry(undefined);
    expect(isTelemetryEnabled()).toBe(false);

    await initTelemetry({
      endpoint: "",
      headers: "",
      exporter: "otlp-http",
      serviceName: "test",
      environment: "test",
      sampleRate: 1,
    });
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("enables after init and disables after shutdown", async () => {
    await initTelemetry({
      endpoint: "http://127.0.0.1:65535/v1/traces",
      headers: "",
      exporter: "otlp-http",
      serviceName: "test",
      environment: "test",
      sampleRate: 1,
    });
    expect(isTelemetryEnabled()).toBe(true);

    await shutdownTelemetry();
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("is idempotent: double-init shuts down the first provider before creating the second", async () => {
    const cfg = {
      endpoint: "http://127.0.0.1:65535/v1/traces",
      headers: "",
      exporter: "otlp-http" as const,
      serviceName: "test",
      environment: "test",
      sampleRate: 1,
    };

    await initTelemetry(cfg);
    expect(isTelemetryEnabled()).toBe(true);

    // Second call must not throw and must leave tracing enabled (not leak
    // a zombie provider). The implementation tears the old one down first.
    await expect(initTelemetry(cfg)).resolves.toBeUndefined();
    expect(isTelemetryEnabled()).toBe(true);
  });

  it("shutdownTelemetry on a never-initialized SDK is a no-op", async () => {
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
    expect(isTelemetryEnabled()).toBe(false);
  });
});
