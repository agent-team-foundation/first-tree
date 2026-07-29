import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { sanitizePath } from "../analytics.js";

const indexHtml = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const bootstrapSource = readFileSync(new URL("../bootstrap.ts", import.meta.url), "utf8");
const themeInitSource = readFileSync(new URL("../../public/theme-init.js", import.meta.url), "utf8");

describe("production gtag bootstrap", () => {
  it("queues the official Arguments object so gtag.js processes commands", () => {
    expect(bootstrapSource).toContain("analyticsWindow.dataLayer?.push(arguments)");
    expect(bootstrapSource).not.toContain("analyticsWindow.dataLayer?.push(args)");
  });

  it("keeps every index script external for an enforced CSP", () => {
    const document = new Window().document;
    document.write(indexHtml);

    const scripts = [...document.scripts];
    expect(scripts).toHaveLength(2);
    expect(scripts.every((script) => script.hasAttribute("src"))).toBe(true);
    expect(scripts.map((script) => script.getAttribute("src"))).toEqual(["/theme-init.js", "/src/bootstrap.ts"]);
    expect(scripts.every((script) => script.textContent?.trim() === "")).toBe(true);
  });

  it("disables Zod runtime code generation before importing the application", () => {
    expect(bootstrapSource).toContain("configureZod({ jitless: true })");
    expect(bootstrapSource.indexOf("configureZod({ jitless: true })")).toBeLessThan(
      bootstrapSource.indexOf('import("./main.js")'),
    );
    expect(indexHtml).not.toContain('src="/src/main.tsx"');
  });

  it("keeps the theme initializer blocking, external, and storage-safe", () => {
    const document = new Window().document;
    document.write(indexHtml);
    const [themeScript] = [...document.scripts];

    expect(themeScript?.getAttribute("src")).toBe("/theme-init.js");
    expect(themeScript?.hasAttribute("async")).toBe(false);
    expect(themeScript?.hasAttribute("defer")).toBe(false);
    expect(themeScript?.hasAttribute("type")).toBe(false);
    expect(themeInitSource).toContain('localStorage.getItem("theme")');
    expect(themeInitSource).toContain("catch");
  });

  it("keeps GA4 advertising endpoints disabled under the exact CSP allowlist", () => {
    expect(bootstrapSource).toContain("allow_google_signals: false");
    expect(bootstrapSource).toContain("allow_ad_personalization_signals: false");
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
