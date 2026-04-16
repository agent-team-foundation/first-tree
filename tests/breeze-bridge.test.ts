import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BREEZE_RUNNER_BIN_NAME,
  BREEZE_RUNNER_ENV,
  MAINTAINER_RUNNER_RELATIVE_PATH,
  resolveBreezeRunner,
  resolveBundledBreezeScript,
  resolveBreezeSetupScript,
  resolveFirstTreePackageRoot,
  spawnInherit,
} from "../src/products/breeze/bridge.js";
import type { SpawnFn } from "../src/products/breeze/bridge.js";
import { join } from "node:path";

function envReader(env: Record<string, string | undefined>) {
  return (name: string) => env[name];
}

describe("resolveBreezeRunner", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Tests never touch the real environment.
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("honours BREEZE_RUNNER_BIN when the file exists", () => {
    const resolved = resolveBreezeRunner({
      env: envReader({ [BREEZE_RUNNER_ENV]: "/tmp/fake-runner" }),
      fileExists: (p) => p === "/tmp/fake-runner",
      pathLookup: () => "/usr/local/bin/breeze-runner",
      packageRoot: "/pkg",
    });
    expect(resolved).toEqual({ path: "/tmp/fake-runner", source: "env" });
  });

  it("rejects BREEZE_RUNNER_BIN when the file does not exist", () => {
    expect(() =>
      resolveBreezeRunner({
        env: envReader({ [BREEZE_RUNNER_ENV]: "/tmp/does-not-exist" }),
        fileExists: () => false,
        pathLookup: () => null,
        packageRoot: "/pkg",
      }),
    ).toThrow(/BREEZE_RUNNER_BIN is set to/);
  });

  it("prefers PATH lookup when no env override is set", () => {
    const resolved = resolveBreezeRunner({
      env: envReader({}),
      fileExists: () => true,
      pathLookup: (name) =>
        name === BREEZE_RUNNER_BIN_NAME
          ? "/usr/local/bin/breeze-runner"
          : null,
      packageRoot: "/pkg",
    });
    expect(resolved).toEqual({
      path: "/usr/local/bin/breeze-runner",
      source: "path",
    });
  });

  it("falls back to the maintainer-local release binary", () => {
    const expected = join("/pkg", MAINTAINER_RUNNER_RELATIVE_PATH);
    const resolved = resolveBreezeRunner({
      env: envReader({}),
      fileExists: (p) => p === expected,
      pathLookup: () => null,
      packageRoot: "/pkg",
    });
    expect(resolved).toEqual({
      path: expected,
      source: "maintainer-fallback",
    });
  });

  it("throws the installation hint when nothing resolves", () => {
    expect(() =>
      resolveBreezeRunner({
        env: envReader({}),
        fileExists: () => false,
        pathLookup: () => null,
        packageRoot: "/pkg",
      }),
    ).toThrow(/cargo install --path \./);
  });

  it("priority: env beats PATH beats maintainer fallback", () => {
    // env present + PATH hit + fallback present → env wins
    const allPresent = resolveBreezeRunner({
      env: envReader({ [BREEZE_RUNNER_ENV]: "/env/runner" }),
      fileExists: () => true,
      pathLookup: () => "/path/runner",
      packageRoot: "/pkg",
    });
    expect(allPresent.source).toBe("env");

    // no env + PATH hit + fallback present → PATH wins
    const pathWins = resolveBreezeRunner({
      env: envReader({}),
      fileExists: () => true,
      pathLookup: () => "/path/runner",
      packageRoot: "/pkg",
    });
    expect(pathWins.source).toBe("path");

    // no env + no PATH + fallback present → fallback
    const fallbackWins = resolveBreezeRunner({
      env: envReader({}),
      fileExists: (p) => p === join("/pkg", MAINTAINER_RUNNER_RELATIVE_PATH),
      pathLookup: () => null,
      packageRoot: "/pkg",
    });
    expect(fallbackWins.source).toBe("maintainer-fallback");
  });
});

describe("resolveBundledBreezeScript", () => {
  it("resolves script paths relative to the package root", () => {
    const p = resolveBundledBreezeScript("breeze-watch", {
      packageRoot: "/pkg",
      fileExists: (path) =>
        path === "/pkg/assets/breeze/bin/breeze-watch",
    });
    expect(p).toBe("/pkg/assets/breeze/bin/breeze-watch");
  });

  it("throws a helpful error when the script is missing", () => {
    expect(() =>
      resolveBundledBreezeScript("breeze-watch", {
        packageRoot: "/pkg",
        fileExists: () => false,
      }),
    ).toThrow(/breeze-watch/);
  });
});

describe("resolveBreezeSetupScript", () => {
  it("resolves first-tree-breeze/setup", () => {
    const p = resolveBreezeSetupScript({
      packageRoot: "/pkg",
      fileExists: (path) => path === "/pkg/first-tree-breeze/setup",
    });
    expect(p).toBe("/pkg/first-tree-breeze/setup");
  });

  it("throws when setup is missing", () => {
    expect(() =>
      resolveBreezeSetupScript({
        packageRoot: "/pkg",
        fileExists: () => false,
      }),
    ).toThrow(/setup script not found/);
  });
});

describe("resolveFirstTreePackageRoot", () => {
  it("finds the real package root from this module", () => {
    const root = resolveFirstTreePackageRoot();
    // The real repo root always contains src/ and assets/breeze/.
    expect(root).toMatch(/first-tree/);
  });
});

describe("spawnInherit", () => {
  it("forwards the child's exit code", () => {
    const spawn = vi.fn().mockReturnValue({
      status: 42,
      signal: null,
      error: undefined,
    }) as unknown as SpawnFn;

    const code = spawnInherit("/bin/echo", ["hi"], { spawn });
    expect(code).toBe(42);
    expect(spawn).toHaveBeenCalledWith("/bin/echo", ["hi"], {
      stdio: "inherit",
    });
  });

  it("returns 0 when status is 0", () => {
    const spawn = vi.fn().mockReturnValue({
      status: 0,
      signal: null,
      error: undefined,
    }) as unknown as SpawnFn;
    expect(spawnInherit("/bin/true", [], { spawn })).toBe(0);
  });

  it("passes args through verbatim without reinterpretation", () => {
    const spawn = vi.fn().mockReturnValue({
      status: 0,
      signal: null,
      error: undefined,
    }) as unknown as SpawnFn;

    spawnInherit(
      "/bin/breeze-runner",
      ["run", "--foo=bar", "--flag", "positional"],
      { spawn },
    );
    expect(spawn).toHaveBeenCalledWith(
      "/bin/breeze-runner",
      ["run", "--foo=bar", "--flag", "positional"],
      { stdio: "inherit" },
    );
  });

  it("returns 1 and writes a helpful error when spawn fails with ENOENT", () => {
    const spawn = vi.fn().mockReturnValue({
      status: null,
      signal: null,
      error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
    }) as unknown as SpawnFn;

    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const code = spawnInherit("/does/not/exist", ["run"], { spawn });
      expect(code).toBe(1);
      expect(writes.join("")).toContain("failed to spawn");
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it("maps signal termination to exit code 1", () => {
    const spawn = vi.fn().mockReturnValue({
      status: null,
      signal: "SIGTERM",
      error: undefined,
    }) as unknown as SpawnFn;
    expect(spawnInherit("/bin/breeze-runner", [], { spawn })).toBe(1);
  });
});
