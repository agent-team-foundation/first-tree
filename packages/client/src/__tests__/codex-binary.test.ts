import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCodexClientWithBinaryFallback,
  findCodexExecutableOnPath,
  formatCodexBinaryMissingMessage,
  isCodexBinaryMissingError,
} from "../runtime/codex-binary.js";

describe("codex binary resolution", () => {
  let tmp: string | null = null;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it("recognises SDK and CLI wrapper binary-missing errors", () => {
    expect(isCodexBinaryMissingError("Unable to locate Codex CLI binaries for x86_64-apple-darwin")).toBe(true);
    expect(
      isCodexBinaryMissingError(
        "Missing optional dependency @openai/codex-darwin-x64. Reinstall Codex: npm install -g @openai/codex@latest",
      ),
    ).toBe(true);
    const stackOnly = new Error("codex startup failed");
    stackOnly.stack = "Error: codex startup failed\n    at findCodexPath (index.js:445:11)";
    expect(isCodexBinaryMissingError(stackOnly)).toBe(true);
    expect(isCodexBinaryMissingError("Your access token expired")).toBe(false);
  });

  it("falls back to a PATH codex executable when bundled resolution fails", () => {
    const calls: unknown[] = [];
    const log = vi.fn();
    const result = createCodexClientWithBinaryFallback(
      { env: { PATH: "/usr/local/bin" } },
      (options) => {
        calls.push(options);
        if (!("codexPathOverride" in options)) {
          throw new Error("Unable to locate Codex CLI binaries for x86_64-apple-darwin");
        }
        return { ok: true, options };
      },
      {
        resolvePath: () => "/usr/local/bin/codex",
        log,
      },
    );

    expect(result).toMatchObject({
      client: { ok: true },
      runtimeSource: "path",
      codexPathOverride: "/usr/local/bin/codex",
    });
    expect(calls).toHaveLength(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("falling back to system codex"));
  });

  it("throws an actionable error when neither bundled nor PATH codex exists", () => {
    expect(() =>
      createCodexClientWithBinaryFallback(
        {},
        () => {
          throw new Error(
            "Unable to locate Codex CLI binaries. Ensure @openai/codex is installed with optional dependencies.",
          );
        },
        { resolvePath: () => null },
      ),
    ).toThrow(/npm install -g @openai\/codex/);
  });

  it("does not swallow non-binary constructor errors", () => {
    expect(() =>
      createCodexClientWithBinaryFallback(
        {},
        () => {
          throw new Error("config exploded");
        },
        { resolvePath: () => "/usr/local/bin/codex" },
      ),
    ).toThrow("config exploded");
  });

  it("finds an executable codex on PATH", () => {
    tmp = mkdtempSync(join(tmpdir(), "ft-codex-path-"));
    const executable = join(tmp, "codex");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);

    expect(findCodexExecutableOnPath({ PATH: `${tmp}${delimiter}/bin` })).toBe(executable);
  });

  it("formats binary-missing messages with the original cause", () => {
    const message = formatCodexBinaryMissingMessage("Unable to locate Codex CLI binaries");
    expect(message).toContain("Codex runtime binary is missing");
    expect(message).toContain("Original error: Unable to locate Codex CLI binaries");
  });
});
