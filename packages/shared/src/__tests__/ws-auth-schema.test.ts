import { describe, expect, it } from "vitest";
import {
  ADMIN_WS_PROTOCOL_VERSION,
  adminWsAuthFrameSchema,
  adminWsAuthOkFrameSchema,
  adminWsServerHelloFrameSchema,
  authControlFrameSchema,
  authExpiredFrameSchema,
  authRejectedFrameSchema,
  authRetryableFrameSchema,
  serverWelcomeFrameSchema,
} from "../schemas/ws-auth.js";

const ADMIN_NONCE = "abcdefghijklmnopqrstuv";

describe("admin websocket challenge schemas", () => {
  it("binds hello, auth, and auth:ok to one protocol version and nonce", () => {
    expect(
      adminWsServerHelloFrameSchema.safeParse({
        type: "server:hello",
        protocolVersion: ADMIN_WS_PROTOCOL_VERSION,
        authority: "https://server.test/api/v1",
        nonce: ADMIN_NONCE,
      }).success,
    ).toBe(true);
    expect(
      adminWsAuthFrameSchema.safeParse({
        type: "auth",
        protocolVersion: ADMIN_WS_PROTOCOL_VERSION,
        nonce: ADMIN_NONCE,
        token: "access-token",
      }).success,
    ).toBe(true);
    expect(
      adminWsAuthOkFrameSchema.safeParse({
        type: "auth:ok",
        protocolVersion: ADMIN_WS_PROTOCOL_VERSION,
        nonce: ADMIN_NONCE,
      }).success,
    ).toBe(true);
  });

  it.each([
    { type: "auth", protocolVersion: 2, nonce: ADMIN_NONCE, token: "access-token" },
    { type: "auth", protocolVersion: ADMIN_WS_PROTOCOL_VERSION, nonce: "short", token: "access-token" },
    {
      type: "auth",
      protocolVersion: ADMIN_WS_PROTOCOL_VERSION,
      nonce: ADMIN_NONCE,
      token: "access-token",
      extra: true,
    },
  ])("rejects an invalid or ambiguous admin auth challenge echo", (frame) => {
    expect(adminWsAuthFrameSchema.safeParse(frame).success).toBe(false);
  });
});

describe("auth control frame schemas", () => {
  it("accepts auth:rejected with a finite rejection code", () => {
    const res = authRejectedFrameSchema.safeParse({
      type: "auth:rejected",
      code: "invalid_token",
      message: "signature verification failed",
    });
    expect(res.success).toBe(true);
  });

  it("accepts auth:expired without a free-form payload", () => {
    const res = authExpiredFrameSchema.safeParse({ type: "auth:expired" });
    expect(res.success).toBe(true);
  });

  it("accepts auth:retryable with retryAfterMs", () => {
    const res = authRetryableFrameSchema.safeParse({
      type: "auth:retryable",
      code: "auth_backend_unavailable",
      retryAfterMs: 2500,
      message: "database unavailable",
    });
    expect(res.success).toBe(true);
  });

  it("classifies auth_timeout as retryable, not rejected", () => {
    expect(
      authRetryableFrameSchema.safeParse({
        type: "auth:retryable",
        code: "auth_timeout",
      }).success,
    ).toBe(true);
    expect(
      authRejectedFrameSchema.safeParse({
        type: "auth:rejected",
        code: "auth_timeout",
      }).success,
    ).toBe(false);
  });

  it("parses the finite auth control union by frame type", () => {
    const res = authControlFrameSchema.safeParse({
      type: "auth:retryable",
      code: "server_draining",
    });
    expect(res.success).toBe(true);
  });

  it("rejects unknown auth:rejected codes", () => {
    const res = authRejectedFrameSchema.safeParse({
      type: "auth:rejected",
      code: "please_login_again",
    });
    expect(res.success).toBe(false);
  });

  it("rejects unknown auth:retryable codes", () => {
    const res = authRetryableFrameSchema.safeParse({
      type: "auth:retryable",
      code: "try_sometime",
    });
    expect(res.success).toBe(false);
  });
});

describe("serverWelcomeFrameSchema", () => {
  it("accepts a well-formed frame", () => {
    const res = serverWelcomeFrameSchema.safeParse({
      type: "server:welcome",
      serverCommandVersion: "0.9.2",
      serverTimeMs: 1_713_000_000_000,
    });
    expect(res.success).toBe(true);
  });

  it("passes unknown fields through so future server versions can extend the frame", () => {
    const res = serverWelcomeFrameSchema.safeParse({
      type: "server:welcome",
      serverCommandVersion: "1.0.0",
      serverTimeMs: 0,
      channel: "beta",
      featureHints: { sessionPersistence: true },
    });
    expect(res.success).toBe(true);
    if (res.success) {
      // unknown field survives — critical for forward-compat
      expect((res.data as { channel?: string }).channel).toBe("beta");
    }
  });

  it("rejects wrong discriminator", () => {
    const res = serverWelcomeFrameSchema.safeParse({
      type: "auth:ok",
      serverCommandVersion: "0.9.2",
      serverTimeMs: 0,
    });
    expect(res.success).toBe(false);
  });

  it("rejects empty serverCommandVersion", () => {
    const res = serverWelcomeFrameSchema.safeParse({
      type: "server:welcome",
      serverCommandVersion: "",
      serverTimeMs: 0,
    });
    expect(res.success).toBe(false);
  });

  it("rejects negative serverTimeMs", () => {
    const res = serverWelcomeFrameSchema.safeParse({
      type: "server:welcome",
      serverCommandVersion: "0.9.2",
      serverTimeMs: -1,
    });
    expect(res.success).toBe(false);
  });

  it("accepts a capabilities block advertising wsInboxDeliver", () => {
    const res = serverWelcomeFrameSchema.safeParse({
      type: "server:welcome",
      serverCommandVersion: "1.0.0",
      serverTimeMs: 1_713_000_000_000,
      capabilities: { wsInboxDeliver: true, wsInboxAckConfirm: true },
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.capabilities?.wsInboxDeliver).toBe(true);
      expect(res.data.capabilities?.wsInboxAckConfirm).toBe(true);
    }
  });

  it("accepts an empty capabilities object and defaults WS capabilities to false", () => {
    const res = serverWelcomeFrameSchema.safeParse({
      type: "server:welcome",
      serverCommandVersion: "1.0.0",
      serverTimeMs: 0,
      capabilities: {},
    });
    expect(res.success).toBe(true);
    if (res.success) {
      // The field default + .partial() inflate `{}` → `{wsInboxDeliver:false}`,
      // matching the server-side behaviour: unset == "no opt-in".
      expect(res.data.capabilities?.wsInboxDeliver).toBe(false);
      expect(res.data.capabilities?.wsInboxAckConfirm).toBe(false);
    }
  });

  it("accepts a welcome with no capabilities key at all (legacy server)", () => {
    const res = serverWelcomeFrameSchema.safeParse({
      type: "server:welcome",
      serverCommandVersion: "0.9.2",
      serverTimeMs: 0,
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.capabilities).toBeUndefined();
    }
  });
});
