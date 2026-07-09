import { describe, expect, it } from "vitest";

describe("package public entry", () => {
  it("re-exports App", async () => {
    const mod = await import("../index.js");
    expect(mod.App).toBeTypeOf("function");
  });
});
