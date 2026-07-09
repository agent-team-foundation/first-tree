import { afterEach, describe, expect, it, vi } from "vitest";

const originalPlatform = process.platform;
const originalArch = process.arch;

function setProcessTarget(platform: NodeJS.Platform, arch: NodeJS.Architecture): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  Object.defineProperty(process, "arch", { configurable: true, value: arch });
}

describe("resolveBundledCodexBinary — platform edge mapping", () => {
  afterEach(() => {
    vi.doUnmock("node:module");
    vi.resetModules();
    setProcessTarget(originalPlatform, originalArch);
  });

  it("reports unsupported platforms before resolving SDK packages", async () => {
    setProcessTarget("freebsd", "x64");
    const { resolveBundledCodexBinary } = await import("../runtime/capabilities/codex.js");

    await expect(resolveBundledCodexBinary()).resolves.toEqual({
      ok: false,
      error: "unsupported platform for codex: freebsd (x64)",
    });
  });

  it.each([
    ["linux", "arm64", "@openai/codex-linux-arm64"],
    ["darwin", "x64", "@openai/codex-darwin-x64"],
    ["win32", "arm64", "@openai/codex-win32-arm64"],
  ] satisfies ReadonlyArray<
    readonly [NodeJS.Platform, NodeJS.Architecture, string]
  >)("uses the %s/%s optional package name in missing-binary diagnostics", async (platform, arch, expectedPackage) => {
    setProcessTarget(platform, arch);
    vi.resetModules();
    vi.doMock("node:module", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:module")>();
      return {
        ...actual,
        createRequire: (anchor: string | URL) => ({
          resolve: (specifier: string) => {
            if (specifier === "@openai/codex/package.json") {
              return "/virtual/node_modules/@openai/codex/package.json";
            }
            throw new Error(`missing ${specifier} from ${String(anchor)}`);
          },
        }),
      };
    });
    const { resolveBundledCodexBinary } = await import("../runtime/capabilities/codex.js");

    const result = await resolveBundledCodexBinary();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected missing bundled binary");
    expect(result.error).toContain(expectedPackage);
  });
});
