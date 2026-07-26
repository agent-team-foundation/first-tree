import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KIMI_CODE_SDK_VERSION, probeKimiCodeCapability } from "../runtime/capabilities/kimi-code.js";
import { findKimiExecutableOnPath } from "../runtime/kimi-binary.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeExecutable(path: string): void {
  writeFileSync(path, "#!/bin/sh\necho kimi-fake\n", { mode: 0o755 });
  chmodSync(path, 0o755);
}

describe("probeKimiCodeCapability", () => {
  it("reports missing when no kimi CLI resolves (isolated HOME/PATH)", async () => {
    const emptyHome = makeTempDir("kimi-cap-empty-home-");
    const entry = await probeKimiCodeCapability({
      env: { HOME: emptyHome, PATH: "" },
      findOnPath: (env) =>
        findKimiExecutableOnPath(env, {
          wellKnownDirs: () => [],
          loginShellPathDirs: () => [],
        }),
    });
    expect(entry).toMatchObject({
      state: "missing",
      available: false,
    });
    expect(entry.error).toMatch(/Official Kimi CLI is missing/i);
    expect(entry.runtimeSource).toBeUndefined();
  });

  it("reports ok when an official kimi executable is resolvable", async () => {
    const binDir = makeTempDir("kimi-cap-bin-");
    const kimiPath = join(binDir, "kimi");
    makeExecutable(kimiPath);

    const entry = await probeKimiCodeCapability({
      env: { HOME: makeTempDir("kimi-cap-home-"), PATH: binDir },
      findOnPath: (env) =>
        findKimiExecutableOnPath(env, {
          wellKnownDirs: () => [],
          loginShellPathDirs: () => [],
        }),
    });
    expect(entry).toMatchObject({
      state: "ok",
      available: true,
      sdkVersion: KIMI_CODE_SDK_VERSION,
      runtimeSource: "bundled",
      runtimePath: null,
    });
  });

  it("does not report ok merely because the bundled SDK is present", async () => {
    // The bundled SDK package remains a client dependency; capability must still
    // require a real host `kimi` CLI. Injecting a finder that always misses
    // proves the probe no longer hard-codes installed:true from the SDK alone.
    expect(KIMI_CODE_SDK_VERSION).toBe("0.26.0-botiverse.2");
    const entry = await probeKimiCodeCapability({
      findOnPath: () => null,
    });
    expect(entry).toMatchObject({
      state: "missing",
      available: false,
    });
    expect(entry.sdkVersion).toBeUndefined();
  });

  it("findOnPath injectable seam drives ok without touching the real host PATH", async () => {
    const findOnPath = vi.fn(() => "/opt/fake/kimi");
    const entry = await probeKimiCodeCapability({ findOnPath });
    expect(findOnPath).toHaveBeenCalledOnce();
    expect(entry).toMatchObject({
      state: "ok",
      available: true,
      sdkVersion: KIMI_CODE_SDK_VERSION,
      runtimeSource: "bundled",
      runtimePath: null,
    });
  });
});
