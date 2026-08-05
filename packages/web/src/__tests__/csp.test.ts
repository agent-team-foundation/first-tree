import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_CSP_SCRIPT_ORIGINS } from "@first-tree/shared/config";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

/**
 * Regression net for the enforced app-wide Content-Security-Policy
 * (`packages/server/src/security-headers.ts`, issue 1541).
 *
 * The server sends `script-src 'self' <enumerated analytics origins>` with no
 * `unsafe-inline` and no nonces, which is only viable while index.html keeps
 * ZERO inline scripts. Anyone re-adding an inline bootstrap (the pre-CSP
 * layout) would ship a page whose script silently never runs in production.
 * These tests fail that change at CI time instead.
 */

const indexHtml = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

/**
 * Every <script> element in index.html, extracted with a real HTML parser
 * (happy-dom's DOMParser) rather than a regex, so end-tag variants such as
 * `</script >` cannot slip past the scan (CodeQL js/bad-tag-filter).
 */
function scriptTags(html: string): Array<{ src: string | null; body: string }> {
  const window = new Window();
  try {
    const doc = new window.DOMParser().parseFromString(html, "text/html");
    return Array.from(doc.querySelectorAll("script"), (tag) => ({
      src: tag.getAttribute("src"),
      body: tag.textContent ?? "",
    }));
  } finally {
    window.close();
  }
}

describe("index.html under enforced CSP (script-src 'self', no unsafe-inline)", () => {
  it("contains only external scripts — every <script> has a src and an empty body", () => {
    const tags = scriptTags(indexHtml);
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag.src).toBeTruthy();
      expect(tag.body.trim()).toBe("");
    }
  });

  it("references bootstrap scripts that exist in public/ (copied to dist root by Vite)", () => {
    const srcs = scriptTags(indexHtml)
      .map((tag) => tag.src)
      .filter((src): src is string => Boolean(src))
      // `/src/main.tsx` is the Vite module entry — rewritten at build time.
      .filter((src) => src.startsWith("/") && !src.startsWith("/src/"));

    expect(srcs).toEqual(["/theme-init.js", "/analytics-init.js"]);
    for (const src of srcs) {
      expect(existsSync(new URL(`../../public${src}`, import.meta.url))).toBe(true);
    }
  });

  it("keeps every third-party loader origin in the default CSP script-src allowlist", () => {
    const analyticsInit = readFileSync(new URL("../../public/analytics-init.js", import.meta.url), "utf8");
    const loaderUrls = analyticsInit.match(/https:\/\/[^"' ]+/g) ?? [];
    expect(loaderUrls.length).toBeGreaterThan(0);
    for (const url of loaderUrls) {
      const origin = new URL(url).origin;
      expect(DEFAULT_CSP_SCRIPT_ORIGINS).toContain(origin);
    }
  });
});
