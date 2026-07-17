import { describe, expect, it } from "vitest";
import { signOAuthState, verifyOAuthState } from "../services/oauth-state.js";

const SECRET = "test-jwt-secret-key-for-vitest";

describe("OAuth state JWT", () => {
  it("round-trips a fresh state token", async () => {
    const { token, nonce } = await signOAuthState(SECRET, "/welcome");
    const result = await verifyOAuthState(SECRET, token, nonce);
    expect(result.next).toBe("/welcome");
    expect(result.targetOrganizationId).toBeUndefined();
  });

  it("round-trips a targetOrganizationId when supplied", async () => {
    const { token, nonce } = await signOAuthState(SECRET, "/settings/github", {
      targetOrganizationId: "01961234-aaaa-7000-8000-000000000001",
    });
    const result = await verifyOAuthState(SECRET, token, nonce);
    expect(result.next).toBe("/settings/github");
    expect(result.targetOrganizationId).toBe("01961234-aaaa-7000-8000-000000000001");
  });

  it("round-trips the GitHub App installation intent", async () => {
    const { token, nonce } = await signOAuthState(SECRET, "/settings/github", {
      intent: "install",
      provider: "github",
      targetOrganizationId: "01961234-aaaa-7000-8000-000000000001",
    });
    const result = await verifyOAuthState(SECRET, token, nonce);
    expect(result).toMatchObject({
      next: "/settings/github",
      intent: "install",
      provider: "github",
    });
  });

  it("round-trips the identity row bound to an unlink reauthentication", async () => {
    const targetIdentityId = "01961234-bbbb-7000-8000-000000000002";
    const { token, nonce } = await signOAuthState(SECRET, "/user-settings", {
      intent: "unlink",
      userId: "01961234-cccc-7000-8000-000000000003",
      provider: "google",
      targetIdentityId,
    });
    const result = await verifyOAuthState(SECRET, token, nonce);
    expect(result).toMatchObject({
      next: "/user-settings",
      intent: "unlink",
      provider: "google",
      targetIdentityId,
    });
  });

  it("rejects a tampered state token", async () => {
    const { token, nonce } = await signOAuthState(SECRET, "/welcome");
    // Flip the FIRST char of the signature segment, not the last.
    // The signature is HMAC-SHA256 (32 bytes / 256 bits) → 43 base64url
    // chars, but the last char encodes only 4 data bits + 2 zero pad bits
    // (since 256 % 6 == 4). Multiple base64url chars decode to the same
    // trailing byte (e.g. 'Y' (011000) and 'a' (011010) both yield data
    // bits 0110), so flipping the last char silently passes ~1/16 of the
    // time when the original happens to share data bits with the
    // replacement. The first sig char carries 6 full data bits — flipping
    // it always changes the decoded signature.
    const dot = token.lastIndexOf(".");
    const head = token.charAt(dot + 1);
    const tampered = `${token.slice(0, dot + 1)}${head === "A" ? "B" : "A"}${token.slice(dot + 2)}`;
    await expect(verifyOAuthState(SECRET, tampered, nonce)).rejects.toThrow();
  });

  it("rejects a state token signed with a different secret", async () => {
    const { token, nonce } = await signOAuthState(SECRET, "/welcome");
    await expect(verifyOAuthState(`${SECRET}-other`, token, nonce)).rejects.toThrow();
  });

  it("rejects when the cookie nonce is missing", async () => {
    const { token } = await signOAuthState(SECRET, "/welcome");
    await expect(verifyOAuthState(SECRET, token, null)).rejects.toThrow();
  });

  it("rejects when the cookie nonce mismatches", async () => {
    const { token } = await signOAuthState(SECRET, "/welcome");
    await expect(verifyOAuthState(SECRET, token, "different-nonce")).rejects.toThrow();
  });
});
