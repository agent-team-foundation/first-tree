import { describe, expect, it, vi } from "vitest";
import {
  resolveFirstTreePackageRoot,
  spawnInherit,
  type SpawnFn,
} from "../src/products/breeze/engine/bridge.js";

describe("resolveFirstTreePackageRoot", () => {
  it("returns a directory that contains the first-tree package.json", () => {
    const root = resolveFirstTreePackageRoot();
    expect(typeof root).toBe("string");
    expect(root.length).toBeGreaterThan(0);
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
