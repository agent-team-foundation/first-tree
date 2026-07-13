import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeClaudeCodeCapability, resolveBundledClaudeBinary } from "../runtime/capabilities/claude-code.js";

const originalPlatform = process.platform;
const originalArch = process.arch;

function setProcessTarget(platform: NodeJS.Platform, arch: NodeJS.Architecture): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  Object.defineProperty(process, "arch", { configurable: true, value: arch });
}

afterEach(() => {
  setProcessTarget(originalPlatform, originalArch);
  vi.doUnmock("node:module");
  vi.resetModules();
});

describe("resolveBundledClaudeBinary edge cases", () => {
  it("reports unsupported platform targets before resolving platform packages", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-unsupported-"));
    try {
      const sdkDir = join(root, "sdk");
      mkdirSync(sdkDir);
      setProcessTarget("freebsd", "x64");

      expect(() => resolveBundledClaudeBinary({ locateSdkDir: () => sdkDir })).toThrow(
        /no bundled Claude binary for freebsd-x64/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats absent optional platform packages as unresolved candidates", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-platform-missing-"));
    try {
      const sdkDir = join(root, "sdk");
      mkdirSync(sdkDir);
      setProcessTarget("linux", "x64");
      vi.resetModules();
      vi.doMock("node:module", async (importOriginal) => {
        const actual = await importOriginal<typeof import("node:module")>();
        return {
          ...actual,
          createRequire: () => ({
            resolve: (specifier: string) => {
              throw new Error(`missing ${specifier}`);
            },
          }),
        };
      });
      const mod = await import("../runtime/capabilities/claude-code.js");

      expect(() => mod.resolveBundledClaudeBinary({ locateSdkDir: () => sdkDir })).toThrow(
        /no installed Claude native binary/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("probeClaudeCodeCapability edge cases", () => {
  it("prefixes a bad override when a resolved path is missing and the bundle is absent", async () => {
    const entry = await probeClaudeCodeCapability({
      resolveExecutable: () => ({
        path: "/missing/claude",
        source: "path",
        overrideError: "CLAUDE_CODE_EXECUTABLE points at a missing file",
      }),
      resolveBundled: () => ({ kind: "native", path: "/missing/bundled-claude" }),
      exists: () => false,
    });

    expect(entry.state).toBe("missing");
    expect(entry.error).toContain("CLAUDE_CODE_EXECUTABLE points at a missing file");
    expect(entry.error).toContain("/missing/bundled-claude");
  });
});
