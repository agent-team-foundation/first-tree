import { describe, expect, it } from "vitest";
import { ALLOWED_POST_INSTALL_NEXT, resolvePostInstallNext } from "../github-app.js";

/**
 * The install-url endpoint bakes its post-install `next` into a signed OAuth
 * state JWT that the callback honors *without re-validation*. So the only
 * gate against an open redirect is this allowlist — keep it tight.
 */
describe("resolvePostInstallNext", () => {
  it("passes through allowlisted internal paths", () => {
    expect(resolvePostInstallNext("/onboarding")).toBe("/onboarding");
    expect(resolvePostInstallNext("/onboarding/connected")).toBe("/onboarding/connected");
    expect(resolvePostInstallNext("/settings/github")).toBe("/settings/github");
    // The Context tab build entry passes itself as `next` when the install popup
    // is blocked — rewriting it to Settings would bounce the admin out of the
    // inline build/repo-pick flow they were in.
    expect(resolvePostInstallNext("/context")).toBe("/context");
  });

  it("falls back to Settings for an absent value", () => {
    expect(resolvePostInstallNext(undefined)).toBe("/settings/github");
  });

  it("falls back to Settings for anything off the allowlist (no open redirect)", () => {
    expect(resolvePostInstallNext("https://evil.example.com")).toBe("/settings/github");
    expect(resolvePostInstallNext("//evil.example.com")).toBe("/settings/github");
    expect(resolvePostInstallNext("/onboarding/../settings")).toBe("/settings/github");
    expect(resolvePostInstallNext("/arbitrary")).toBe("/settings/github");
    expect(resolvePostInstallNext("")).toBe("/settings/github");
  });

  it("only allows the known internal destinations", () => {
    expect([...ALLOWED_POST_INSTALL_NEXT].sort()).toEqual([
      "/context",
      "/onboarding",
      "/onboarding/connected",
      "/settings/github",
    ]);
  });
});
