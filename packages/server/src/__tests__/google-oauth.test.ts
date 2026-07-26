import { describe, expect, it } from "vitest";
import { buildGoogleAuthorizeUrl } from "../services/google-oauth.js";

describe("Google OAuth", () => {
  it("builds an authorization URL with the fixed identity-only scope", () => {
    const url = new URL(
      buildGoogleAuthorizeUrl({
        clientId: "client-id",
        redirectUri: "https://app.example/api/v1/auth/google/callback",
        state: "signed-state",
        nonce: "oidc-nonce",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("signed-state");
    expect(url.searchParams.get("nonce")).toBe("oidc-nonce");
    expect(url.searchParams.get("access_type")).toBeNull();
  });
});
