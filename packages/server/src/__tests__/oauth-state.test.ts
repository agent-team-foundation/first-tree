import { describe, expect, it } from "vitest";
import { signOAuthState, verifyOAuthState } from "../services/oauth-state.js";

const SECRET = "test-jwt-secret-key-for-vitest";

describe("OAuth state JWT", () => {
  it("round-trips a fresh state token", async () => {
    const { token, nonce } = await signOAuthState(SECRET, "/welcome");
    const result = await verifyOAuthState(SECRET, token, nonce);
    expect(result.next).toBe("/welcome");
  });

  it("rejects a tampered state token", async () => {
    const { token, nonce } = await signOAuthState(SECRET, "/welcome");
    // Flip the last char of the signature segment
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
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
