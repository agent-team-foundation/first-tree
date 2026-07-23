import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sanitizePath } from "../analytics.js";

// The GA4/Clarity bootstrap moved out of index.html into an external file so
// the app-wide CSP can enforce `script-src 'self'` without inline allowances
// (see public/analytics-init.js and csp.test.ts).
const analyticsInit = readFileSync(new URL("../../public/analytics-init.js", import.meta.url), "utf8");

describe("production gtag bootstrap", () => {
  it("queues the official Arguments object so gtag.js processes commands", () => {
    expect(analyticsInit).toContain("window.dataLayer.push(arguments)");
    expect(analyticsInit).not.toContain("window.dataLayer.push(args)");
  });
});

describe("sanitizePath", () => {
  it("templates invite tokens so the code never reaches GA", () => {
    expect(sanitizePath("/invite/abc123secret")).toBe("/invite/[token]");
    expect(sanitizePath("/invite/another-long-token")).toBe("/invite/[token]");
  });

  it("collapses the OAuth complete route to a fixed path", () => {
    // The token lives in the hash, but template the path too as defense in depth.
    expect(sanitizePath("/auth/github/complete")).toBe("/auth/github/complete");
  });

  it("passes through ordinary routes unchanged", () => {
    expect(sanitizePath("/")).toBe("/");
    expect(sanitizePath("/agents")).toBe("/agents");
    expect(sanitizePath("/settings/team")).toBe("/settings/team");
  });

  it("does not leak a token even when the invite path has extra segments", () => {
    expect(sanitizePath("/invite/tok/extra")).toBe("/invite/[token]");
  });
});
