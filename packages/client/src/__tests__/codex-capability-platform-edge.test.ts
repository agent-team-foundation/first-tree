import { afterEach, describe, expect, it } from "vitest";
import { resolveBundledCodexBinary } from "../runtime/capabilities/codex.js";

const originalPlatform = process.platform;
const originalArch = process.arch;

function setProcessTarget(platform: NodeJS.Platform, arch: NodeJS.Architecture): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  Object.defineProperty(process, "arch", { configurable: true, value: arch });
}

describe("resolveBundledCodexBinary — platform edge mapping", () => {
  afterEach(() => {
    setProcessTarget(originalPlatform, originalArch);
  });

  it("reports unsupported platforms before resolving SDK packages", async () => {
    setProcessTarget("freebsd", "x64");

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

    const result = await resolveBundledCodexBinary();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected missing bundled binary");
    expect(result.error).toContain(expectedPackage);
  });
});
