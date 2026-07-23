import { describe, expect, it, vi } from "vitest";

/**
 * Guards the zod-jitless bootstrap (issue 1541): zod v4 probes eval support
 * with `new Function(...)` when an object schema is first constructed; under
 * the enforced CSP (no unsafe-eval) that probe is blocked and reported to the
 * console. `src/zod-jitless.ts` must configure `jitless: true` before any
 * shared schema module evaluates.
 */
describe("zod-jitless bootstrap", () => {
  it("configures jitless mode before shared schemas are used", async () => {
    await import("../zod-jitless.js");
    const { globalConfig } = await import("zod/v4/core");
    expect(globalConfig.jitless).toBe(true);
  });

  it("keeps shared object schemas functional when eval is unavailable", async () => {
    // Simulate the enforced CSP: any eval-style construction throws.
    vi.stubGlobal("Function", function blockedFunction(): never {
      throw new Error("eval blocked by Content-Security-Policy");
    });
    try {
      await import("../zod-jitless.js");
      const { askRequestSchema } = await import("@first-tree/shared");
      expect(askRequestSchema.parse({})).toEqual({ multiSelect: false });
      expect(() => askRequestSchema.parse({ multiSelect: true })).toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stays the first import of main.tsx (load order is the contract)", async () => {
    const { readFile } = await import("node:fs/promises");
    const mainSource = await readFile(new URL("../main.tsx", import.meta.url), "utf8");
    const firstImport = mainSource.split("\n").find((line) => line.startsWith("import"));
    expect(firstImport).toBe('import "./zod-jitless.js";');
  });
});
