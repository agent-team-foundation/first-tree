import { describe, expect, it } from "vitest";
import { probeCursorCapability } from "../runtime/capabilities/cursor.js";
import { CURSOR_INSTALL_COMMAND } from "../runtime/cursor-binary.js";

describe("probeCursorCapability — install-only detection", () => {
  it("resolved binary → ok with runtimeSource=path (existence only, never launched)", async () => {
    const entry = await probeCursorCapability({ findOnPath: () => "/home/op/.local/bin/cursor-agent" });
    expect(entry).toMatchObject({
      state: "ok",
      available: true,
      runtimeSource: "path",
      runtimePath: "/home/op/.local/bin/cursor-agent",
    });
  });

  it("nothing resolved → missing with the official installer in the reason", async () => {
    const entry = await probeCursorCapability({ findOnPath: () => null });
    expect(entry).toMatchObject({ state: "missing", available: false });
    expect(entry.error).toContain(CURSOR_INSTALL_COMMAND);
  });

  it("a throwing resolver → error entry, never a rejection", async () => {
    const entry = await probeCursorCapability({
      findOnPath: () => {
        throw new Error("resolver blew up");
      },
    });
    expect(entry).toMatchObject({ state: "error", available: false, error: "resolver blew up" });
  });
});
