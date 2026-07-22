import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * CSP guard (issue 1541): the server delivers `script-src` WITHOUT
 * 'unsafe-inline', so any inline `<script>` in index.html would be silently
 * dead in production once the CSP is enforced. The former inline bootstrap
 * (theme / GA4 / Clarity) lives in `public/init.js`; this test fails the
 * build the moment someone adds a new inline script or drops the external
 * bootstrap, instead of the regression surfacing as a broken page.
 */
const indexHtml = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
const initJs = readFileSync(fileURLToPath(new URL("../public/init.js", import.meta.url)), "utf8");
// Browsers ignore markup inside comments, so the guard should too — the
// prose comment above the bootstrap tag legitimately mentions "<script>".
const markup = indexHtml.replace(/<!--[\s\S]*?-->/g, "");

describe("index.html CSP guard", () => {
  it("has only external <script> tags (every script tag carries src=)", () => {
    const scriptTags = markup.match(/<script\b[^>]*>/gi) ?? [];
    expect(scriptTags.length).toBeGreaterThan(0);
    for (const tag of scriptTags) {
      expect(tag, `inline script is incompatible with the enforced CSP: ${tag}`).toMatch(/\bsrc\s*=/);
    }
  });

  it("loads the /init.js bootstrap", () => {
    expect(markup).toContain('<script src="/init.js"></script>');
  });

  it("carries no meta CSP — the policy is owned by the server response headers", () => {
    // A <meta http-equiv="Content-Security-Policy"> would fork the policy
    // definition; frame-ancestors and report-uri are not even valid there.
    expect(markup.toLowerCase()).not.toContain("http-equiv");
  });
});

describe("public/init.js bootstrap", () => {
  it("runs theme initialization before the analytics loaders (FOUC guard)", () => {
    const themeIndex = initJs.indexOf('localStorage.getItem("theme")');
    const gtagIndex = initJs.indexOf("googletagmanager.com");
    const clarityIndex = initJs.indexOf("clarity.ms");
    expect(themeIndex).toBeGreaterThan(-1);
    expect(gtagIndex).toBeGreaterThan(-1);
    expect(clarityIndex).toBeGreaterThan(-1);
    expect(themeIndex).toBeLessThan(gtagIndex);
    expect(gtagIndex).toBeLessThan(clarityIndex);
  });

  it("keeps the production hostname gate on both analytics loaders", () => {
    const gates = initJs.match(/window\.location\.hostname !== "cloud\.first-tree\.ai"/g) ?? [];
    expect(gates).toHaveLength(2);
  });
});
