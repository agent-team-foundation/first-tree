import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { sanitizePath } from "../analytics.js";

const indexHtml = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const bootstrapSource = readFileSync(new URL("../bootstrap.ts", import.meta.url), "utf8");

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
    expect(indexHtml).toContain('src="/src/bootstrap.ts"');
  });

  it("disables Zod runtime code generation before the application entry", () => {
    expect(bootstrapSource).toContain("configureZod({ jitless: true })");
    expect(indexHtml.indexOf('src="/src/bootstrap.ts"')).toBeLessThan(indexHtml.indexOf('src="/src/main.tsx"'));
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
