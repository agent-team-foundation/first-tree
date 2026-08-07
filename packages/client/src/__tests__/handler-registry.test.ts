import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

describe("handler factory injection (no process-global registry)", () => {
  it("production handler module no longer exports global registry symbols", async () => {
    const handler = await import("../runtime/handler.js");
    expect(handler).not.toHaveProperty("registerHandler");
    expect(handler).not.toHaveProperty("getHandlerFactory");
    expect(handler).not.toHaveProperty("hasHandler");
    expect(handler).not.toHaveProperty("HANDLER_REGISTRY");
  });

  it("source search confirms global registry symbols are gone", () => {
    const handlerSource = readFileSync(join(here, "../runtime/handler.ts"), "utf8");
    for (const symbol of ["HANDLER_REGISTRY", "registerHandler", "getHandlerFactory", "hasHandler"] as const) {
      expect(handlerSource).not.toMatch(new RegExp(`\\b${symbol}\\b`));
    }
  });
});
