import { describe, expect, it } from "vitest";
import {
  authProviderAvailabilitySchema,
  authProviderConnectionsResponseSchema,
  githubCallbackQuerySchema,
  googleCallbackQuerySchema,
  oauthIntentSchema,
  oidcCallbackQuerySchema,
} from "../schemas/oauth.js";

describe("OAuth schemas", () => {
  it("accepts all supported providers and intents", () => {
    expect(oauthIntentSchema.parse("sign-in")).toBe("sign-in");
    expect(authProviderConnectionsResponseSchema.parse({ providers: [] })).toEqual({ providers: [] });
    expect(authProviderAvailabilitySchema.parse({ google: true, github: false })).toEqual({
      google: true,
      github: false,
      oidc: false,
    });
  });

  it("accepts a Google authorization code and state", () => {
    expect(googleCallbackQuerySchema.safeParse({ code: "code", state: "state" }).success).toBe(true);
    expect(googleCallbackQuerySchema.safeParse({ code: "code" }).success).toBe(false);
  });

  it("preserves GitHub provider denial and setup callback shapes", () => {
    expect(githubCallbackQuerySchema.parse({ error: "access_denied", state: "state" })).toMatchObject({
      error: "access_denied",
      state: "state",
    });
    expect(githubCallbackQuerySchema.safeParse({ state: "state", setup_action: "request" }).success).toBe(true);
  });
});

describe("oidcCallbackQuerySchema — boundary validation", () => {
  it("accepts a valid code+state callback", () => {
    const result = oidcCallbackQuerySchema.safeParse({ code: "abc123", state: "signed-state" });
    expect(result.success).toBe(true);
  });

  it("accepts a valid provider error callback", () => {
    const result = oidcCallbackQuerySchema.safeParse({ error: "access_denied", state: "signed-state" });
    expect(result.success).toBe(true);
  });

  it("rejects a callback with neither code+state nor error", () => {
    expect(oidcCallbackQuerySchema.safeParse({}).success).toBe(false);
    expect(oidcCallbackQuerySchema.safeParse({ code: "abc" }).success).toBe(false);
    expect(oidcCallbackQuerySchema.safeParse({ state: "state" }).success).toBe(false);
  });

  it("rejects non-string code", () => {
    expect(oidcCallbackQuerySchema.safeParse({ code: 12345, state: "state" }).success).toBe(false);
  });

  it("rejects non-string state", () => {
    expect(oidcCallbackQuerySchema.safeParse({ code: "code", state: 12345 }).success).toBe(false);
  });

  it("rejects oversized code (>2048 chars)", () => {
    const longCode = "a".repeat(2049);
    expect(oidcCallbackQuerySchema.safeParse({ code: longCode, state: "state" }).success).toBe(false);
  });

  it("rejects oversized state (>4096 chars)", () => {
    const longState = "s".repeat(4097);
    expect(oidcCallbackQuerySchema.safeParse({ code: "code", state: longState }).success).toBe(false);
  });

  it("rejects oversized error (>128 chars)", () => {
    const longError = "e".repeat(129);
    expect(oidcCallbackQuerySchema.safeParse({ error: longError, state: "state" }).success).toBe(false);
  });

  it("accepts code at exactly 2048 chars and state at exactly 4096 chars", () => {
    const borderCode = "a".repeat(2048);
    const borderState = "s".repeat(4096);
    expect(oidcCallbackQuerySchema.safeParse({ code: borderCode, state: borderState }).success).toBe(true);
  });
});
