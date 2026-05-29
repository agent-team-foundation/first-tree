import { describe, expect, it } from "vitest";
import { githubDevCallbackQuerySchema } from "../schemas/oauth.js";

describe("githubDevCallbackQuerySchema", () => {
  it("accepts the dev-only skipOnboarding flag", () => {
    const parsed = githubDevCallbackQuerySchema.parse({
      githubId: "1",
      login: "devuser",
      skipOnboarding: "1",
    });

    expect(parsed.skipOnboarding).toBe("1");
  });

  it("rejects unsupported skipOnboarding values", () => {
    expect(() =>
      githubDevCallbackQuerySchema.parse({
        githubId: "1",
        login: "devuser",
        skipOnboarding: "true",
      }),
    ).toThrow();
  });
});
