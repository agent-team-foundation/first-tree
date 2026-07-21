import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { sanitizePath } from "../analytics.js";

const indexHtml = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const themeInit = readFileSync(new URL("../../public/theme-init.js", import.meta.url), "utf8");

describe("production gtag bootstrap", () => {
  it("uses only external scripts and keeps the blocking theme bootstrap first", () => {
    const scripts = [...indexHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu)];
    expect(scripts).toHaveLength(3);
    expect(scripts.every((match) => /\bsrc=/u.test(match[1] ?? "") && !(match[2] ?? "").trim())).toBe(true);
    expect(scripts[0]?.[1]).toContain('src="/theme-init.js"');
    expect(scripts[0]?.[1]).not.toMatch(/\b(?:async|defer)\b/u);
    expect(scripts[1]?.[1]).toContain('src="/src/browser-bootstrap-entry.ts"');
    expect(indexHtml).not.toMatch(/\son[a-z][a-z0-9:_-]*\s*=/iu);
  });
});

describe("blocking theme bootstrap", () => {
  it.each([
    ["stored dark", "dark", false, true],
    ["stored light overrides the OS", "light", true, false],
    ["OS dark with no stored theme", null, true, true],
    ["OS light with no stored theme", null, false, false],
  ] as const)("preserves %s behavior after static extraction", (_label, storedTheme, prefersDark, expectedDark) => {
    const add = vi.fn();
    runInNewContext(themeInit, {
      localStorage: { getItem: () => storedTheme },
      window: { matchMedia: () => ({ matches: prefersDark }) },
      document: { documentElement: { classList: { add } } },
    });

    expect(add).toHaveBeenCalledTimes(expectedDark ? 1 : 0);
    if (expectedDark) expect(add).toHaveBeenCalledWith("dark");
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
