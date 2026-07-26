import { describe, expect, it } from "vitest";
import {
  authProviderAvailabilitySchema,
  authProviderConnectionsResponseSchema,
  githubCallbackQuerySchema,
  googleCallbackQuerySchema,
  oauthIntentSchema,
} from "../schemas/oauth.js";

describe("OAuth schemas", () => {
  it("accepts all supported providers and intents", () => {
    expect(oauthIntentSchema.parse("sign-in")).toBe("sign-in");
    expect(authProviderConnectionsResponseSchema.parse({ providers: [] })).toEqual({ providers: [] });
    expect(authProviderAvailabilitySchema.parse({ google: true, github: false })).toEqual({
      google: true,
      github: false,
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
