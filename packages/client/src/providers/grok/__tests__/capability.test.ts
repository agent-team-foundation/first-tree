import { describe, expect, it, vi } from "vitest";
import { GROK_INSTALL_COMMAND } from "../binary.js";
import { probeGrokCapability } from "../capability.js";

describe("probeGrokCapability — install-only detection", () => {
  it("resolved binary → ok with runtimeSource=path (existence only, never launched)", async () => {
    const entry = await probeGrokCapability({ findOnPath: () => "/home/op/.grok/bin/grok" });
    expect(entry).toMatchObject({
      state: "ok",
      available: true,
      runtimeSource: "path",
      runtimePath: "/home/op/.grok/bin/grok",
    });
  });

  it("nothing resolved → missing with the official installer in the reason", async () => {
    const entry = await probeGrokCapability({ findOnPath: () => null });
    expect(entry).toMatchObject({ state: "missing", available: false });
    expect(entry.error).toContain(GROK_INSTALL_COMMAND);
  });

  it("win32 → state error (NOT missing) fail-closed WITHOUT consulting the filesystem or spawning", async () => {
    // The platform gate must short-circuit BEFORE the resolver runs: no
    // findOnPath call, no `grok` spawn, no credential / network inspection.
    // state `error` (not `missing`) keeps the Web setup cards from rendering
    // the install command for a runtime V1 does not support on Windows.
    const findOnPath = vi.fn(() => "/fake/grok");
    const entry = await probeGrokCapability({ platform: "win32", findOnPath });
    expect(entry).toMatchObject({ state: "error", available: false });
    expect(entry.error).toContain("not supported on Windows in V1");
    expect(findOnPath).not.toHaveBeenCalled();
  });

  it("non-win32 platforms still resolve normally", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const entry = await probeGrokCapability({ platform, findOnPath: () => "/usr/local/bin/grok" });
      expect(entry).toMatchObject({ state: "ok", available: true, runtimeSource: "path" });
    }
  });

  it("a throwing resolver → error entry, never a rejection", async () => {
    const entry = await probeGrokCapability({
      findOnPath: () => {
        throw new Error("resolver blew up");
      },
    });
    expect(entry).toMatchObject({ state: "error", available: false, error: "resolver blew up" });
  });
});
