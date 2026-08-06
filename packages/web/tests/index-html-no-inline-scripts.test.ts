// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
// happy-dom shadows the global URL, so resolve paths without `new URL(...)`:
// `import.meta.url` stays a file:// string that fileURLToPath handles directly.
const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexHtml = readFileSync(join(webRoot, "index.html"), "utf8");
const initJs = readFileSync(join(webRoot, "public", "init.js"), "utf8");
// Parse the markup instead of regex-scanning it so commented-out markup is
// ignored exactly the way a browser ignores it (the prose comment above the
// bootstrap tag legitimately mentions "<script>"). DOMParser documents are
// inert: nothing from index.html executes here.
const doc = new DOMParser().parseFromString(indexHtml, "text/html");

describe("index.html CSP guard", () => {
  it("has only external <script> tags (every script tag carries src=)", () => {
    const scripts = Array.from(doc.querySelectorAll("script"));
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(
        script.hasAttribute("src"),
        `inline script is incompatible with the enforced CSP: ${script.outerHTML}`,
      ).toBe(true);
    }
  });

  it("loads the /init.js bootstrap", () => {
    expect(doc.querySelector('script[src="/init.js"]')).not.toBeNull();
  });

  it("carries no meta CSP — the policy is owned by the server response headers", () => {
    // A <meta http-equiv="Content-Security-Policy"> would fork the policy
    // definition; frame-ancestors and report-uri are not even valid there.
    expect(doc.querySelector("meta[http-equiv]")).toBeNull();
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
