import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for issue 1541: the enforced Content-Security-Policy has
 * no script-src 'unsafe-inline', so index.html must never ship an inline
 * <script> block. The analytics bootstrap and the pre-paint theme init live
 * in external files under public/.
 */
describe("index.html — no inline scripts", () => {
  it("contains no inline <script> block", async () => {
    const html = await readFile(new URL("../../index.html", import.meta.url), "utf8");
    const scriptTags = html.match(/<script\b[^>]*>/gi) ?? [];
    const inlineScripts = scriptTags.filter((tag) => !/\bsrc\s*=/.test(tag));
    expect(inlineScripts).toEqual([]);
  });

  it("loads the external analytics and theme init scripts with the intended semantics", async () => {
    const html = await readFile(new URL("../../index.html", import.meta.url), "utf8");
    // Theme init must stay synchronous (no async/defer) to run before first paint.
    expect(html).toContain('<script src="/theme-init.js"></script>');
    // Analytics is queue-based and safe to defer off the critical path.
    expect(html).toContain('<script src="/analytics-init.js" defer></script>');
  });
});
