import { describe, expect, it } from "vitest";
import {
  authProviderConnectionsResponseSchema,
  googleCallbackQuerySchema,
  oauthIntentSchema,
} from "../schemas/oauth.js";

describe("OAuth schemas", () => {
  it("accepts all supported providers and intents", () => {
    expect(oauthIntentSchema.parse("sign-in")).toBe("sign-in");
    expect(authProviderConnectionsResponseSchema.parse({ providers: [] })).toEqual({ providers: [] });
  });

  it("accepts a Google authorization code and state", () => {
    expect(googleCallbackQuerySchema.safeParse({ code: "code", state: "state" }).success).toBe(true);
    expect(googleCallbackQuerySchema.safeParse({ code: "code" }).success).toBe(false);
  });
});
