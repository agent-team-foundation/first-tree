import { describe, expect, it } from "vitest";
import {
  initTelemetry,
  isTelemetryEnabled,
  parseHeaderString,
  shutdownTelemetry,
  undiciSpanNameForRequest,
  updateKnownUndiciSpanName,
} from "../logfire-init.js";
import { normalizeAttrs } from "../otel-helpers.js";

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

describe("undici span naming", () => {
  it("names OpenRouter chat completions by method and path without host or query", () => {
    const name = undiciSpanNameForRequest({
      method: "POST",
      origin: "https://openrouter.ai",
      path: "/api/v1/chat/completions?ignored=true",
    });

    expect(name).toBe("POST /api/v1/chat/completions");
  });

  it("keeps provider-specific API prefixes while normalizing trailing slash", () => {
    const name = undiciSpanNameForRequest({
      method: "post",
      origin: "https://api.openai.com",
      path: "/v1/chat/completions/",
    });

    expect(name).toBe("POST /v1/chat/completions");
  });

  it("does not rename unrelated outbound requests", () => {
    const name = undiciSpanNameForRequest({
      method: "POST",
      origin: "https://api.github.com",
      path: "/repos/agent-team-foundation/first-tree/issues",
    });

    expect(name).toBeUndefined();
  });

  it("does not put arbitrary dynamic path prefixes into span names", () => {
    const name = undiciSpanNameForRequest({
      method: "POST",
      origin: "https://example.test",
      path: "/openai/deployments/prod-main/chat/completions",
    });

    expect(name).toBeUndefined();
  });

  it("does not rename malformed undici request data", () => {
    expect(undiciSpanNameForRequest({ method: "POST", origin: "not a url", path: "://bad" })).toBeUndefined();
    expect(undiciSpanNameForRequest({ method: "POST", origin: "https://openrouter.ai" })).toBeUndefined();
  });

  it("updates only known undici span names", () => {
    const calls: string[] = [];
    const span = { updateName: (name: string) => calls.push(name) };

    updateKnownUndiciSpanName(span, {
      method: "POST",
      origin: "https://openrouter.ai",
      path: "/api/v1/chat/completions",
    });
    updateKnownUndiciSpanName(span, {
      method: "GET",
      origin: "https://openrouter.ai",
      path: "/api/v1/models",
    });

    expect(calls).toEqual(["POST /api/v1/chat/completions"]);
  });
});

describe("initTelemetry / shutdownTelemetry lifecycle", () => {
  // We deliberately don't exercise the "happy path" (real `logfire.configure`
  // + `shutdown`) here: the underlying Logfire SDK opens a BatchSpanProcessor
  // whose `shutdown()` blocks on flushing pending spans to the configured
  // OTLP endpoint, which times out (~30s) when the endpoint is unreachable
  // — making the test slow and flaky in CI. The Logfire SDK's own lifecycle
  // is covered upstream; here we only assert the negative paths our wrapper
  // is responsible for (no-op on missing endpoint / token).

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

  it("stays disabled when endpoint is set but no bearer token is in headers", async () => {
    // Logfire requires a token; we treat a missing token as a misconfigured
    // setup and leave tracing disabled rather than silently no-op.
    await initTelemetry({
      endpoint: "http://127.0.0.1:65535/v1/traces",
      headers: "",
      exporter: "otlp-http",
      serviceName: "test",
      environment: "test",
      sampleRate: 1,
    });
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("shutdownTelemetry on a never-initialized SDK is a no-op", async () => {
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
    expect(isTelemetryEnabled()).toBe(false);
  });
});
