import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveFirstTreePackageRoot, type SpawnFn, spawnInherit } from "../../src/github-scan/engine/bridge.js";

const tempRoots: string[] = [];

afterEach(() => {
  vi.doUnmock("node:module");
  vi.resetModules();
  while (tempRoots.length) {
    const dir = tempRoots.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempTree(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `github-scan-bridge-${prefix}-`));
  tempRoots.push(dir);
  return dir;
}

function tempModuleUrl(root: string): string {
  const file = join(root, "nested", "deeper", "entry.mjs");
  mkdirSync(join(root, "nested", "deeper"), { recursive: true });
  writeFileSync(file, "");
  return pathToFileURL(file).href;
}

async function importBridgeWithPackageResolutionFailure(): Promise<
  typeof import("../../src/github-scan/engine/bridge.js")
> {
  vi.resetModules();
  vi.doMock("node:module", () => ({
    createRequire: () => ({
      resolve: () => {
        throw new Error("package not found");
      },
    }),
  }));
  return import("../../src/github-scan/engine/bridge.js");
}

describe("resolveFirstTreePackageRoot", () => {
  it("returns a directory that contains the github-scan package.json", () => {
    const root = resolveFirstTreePackageRoot();
    expect(typeof root).toBe("string");
    expect(root.length).toBeGreaterThan(0);
  });

  it("walks upward to locate bundled dashboard assets outside a workspace install", async () => {
    const bridge = await importBridgeWithPackageResolutionFailure();
    const root = makeTempTree("package-root");
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "assets", "dashboard.html"), "<html></html>");

    expect(bridge.resolveFirstTreePackageRoot(tempModuleUrl(root))).toBe(root);
  });

  it("throws when neither workspace resolution nor bundled assets are available", async () => {
    const bridge = await importBridgeWithPackageResolutionFailure();
    const root = makeTempTree("missing-root");

    expect(() => bridge.resolveFirstTreePackageRoot(tempModuleUrl(root))).toThrow(
      "Could not locate the @first-tree/github-scan package root",
    );
  });
});

describe("resolveStatuslineBundlePath", () => {
  it("walks upward to locate a bundled statusline script", async () => {
    const bridge = await importBridgeWithPackageResolutionFailure();
    const root = makeTempTree("statusline");
    const bundle = join(root, "github-scan-statusline.js");
    writeFileSync(bundle, "console.log('ok');");

    expect(bridge.resolveStatuslineBundlePath(tempModuleUrl(root))).toBe(bundle);
  });

  it("throws when the statusline bundle is absent", async () => {
    const bridge = await importBridgeWithPackageResolutionFailure();
    const root = makeTempTree("missing-statusline");

    expect(() => bridge.resolveStatuslineBundlePath(tempModuleUrl(root))).toThrow("run `pnpm build` first");
  });
});

describe("spawnInherit", () => {
  it("returns the child exit code for a successful spawn", () => {
    const spawn = vi.fn().mockReturnValue({ status: 13 }) as unknown as SpawnFn;
    expect(spawnInherit("true", [], { spawn })).toBe(13);
    expect(spawn).toHaveBeenCalledWith("true", [], { stdio: "inherit" });
  });

  it("returns 0 when status is null and no signal/error is reported", () => {
    const spawn = vi.fn().mockReturnValue({}) as unknown as SpawnFn;
    expect(spawnInherit("true", [], { spawn })).toBe(0);
  });

  it("returns 1 on spawn error and writes a hint to stderr", () => {
    const spawn = vi.fn().mockReturnValue({
      error: new Error("ENOENT"),
    }) as unknown as SpawnFn;
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = spawnInherit("missing-bin", [], { spawn });
      expect(code).toBe(1);
      expect(writes.join("")).toContain("failed to spawn");
    } finally {
      process.stderr.write = orig;
    }
  });

  it("returns 1 when the child terminates via signal", () => {
    const spawn = vi.fn().mockReturnValue({
      signal: "SIGTERM",
    }) as unknown as SpawnFn;
    expect(spawnInherit("sleep", [], { spawn })).toBe(1);
  });
});
