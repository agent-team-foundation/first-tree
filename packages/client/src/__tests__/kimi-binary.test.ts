import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findKimiExecutableOnPath,
  formatKimiBinaryMissingMessage,
  isKimiBinaryMissingError,
  KIMI_CLI_PACKAGE,
  kimiOfficialBinDirs,
} from "../runtime/kimi-binary.js";

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

describe("findKimiExecutableOnPath", () => {
  it("returns null when PATH and fallback dirs are empty", () => {
    expect(
      findKimiExecutableOnPath(
        { HOME: makeTempDir("kimi-bin-empty-"), PATH: "" },
        { wellKnownDirs: () => [], loginShellPathDirs: () => [] },
      ),
    ).toBeNull();
  });

  it("finds kimi on the daemon PATH", () => {
    const binDir = makeTempDir("kimi-bin-path-");
    makeExecutable(join(binDir, "kimi"));
    expect(
      findKimiExecutableOnPath(
        { HOME: makeTempDir("kimi-bin-home-"), PATH: binDir },
        { wellKnownDirs: () => [], loginShellPathDirs: () => [] },
      ),
    ).toBe(join(binDir, "kimi"));
  });

  it("falls back to well-known install dirs when PATH misses", () => {
    const wellKnown = join(makeTempDir("kimi-bin-well-"), "local-bin");
    mkdirSync(wellKnown);
    makeExecutable(join(wellKnown, "kimi"));
    expect(
      findKimiExecutableOnPath(
        { HOME: makeTempDir("kimi-bin-home-"), PATH: "" },
        { wellKnownDirs: () => [wellKnown], loginShellPathDirs: () => [] },
      ),
    ).toBe(join(wellKnown, "kimi"));
  });

  it("falls back to login-shell PATH dirs last", () => {
    const loginBin = makeTempDir("kimi-bin-login-");
    makeExecutable(join(loginBin, "kimi"));
    expect(
      findKimiExecutableOnPath(
        { HOME: makeTempDir("kimi-bin-home-"), PATH: "" },
        { wellKnownDirs: () => [], loginShellPathDirs: () => [loginBin] },
      ),
    ).toBe(join(loginBin, "kimi"));
  });

  it("ignores a non-executable kimi file on PATH", () => {
    const binDir = makeTempDir("kimi-bin-nonexec-");
    writeFileSync(join(binDir, "kimi"), "not executable\n", { mode: 0o644 });
    expect(
      findKimiExecutableOnPath(
        { HOME: makeTempDir("kimi-bin-home-"), PATH: binDir },
        { wellKnownDirs: () => [], loginShellPathDirs: () => [] },
      ),
    ).toBeNull();
  });

  it("finds kimi in the official installer dir with empty daemon PATH and empty login-shell PATH", () => {
    const home = makeTempDir("kimi-bin-official-");
    const officialBin = join(home, ".kimi-code", "bin");
    mkdirSync(officialBin, { recursive: true });
    makeExecutable(join(officialBin, "kimi"));
    expect(kimiOfficialBinDirs(home)).toEqual([officialBin]);
    expect(
      findKimiExecutableOnPath(
        { HOME: home, PATH: "" },
        // Default wellKnownDirs includes the official installer dir; login-shell
        // stays empty to model a frozen daemon PATH that never saw the install.
        { loginShellPathDirs: () => [] },
      ),
    ).toBe(join(officialBin, "kimi"));
  });

  it("finds kimi.exe under %USERPROFILE%\\.kimi-code\\bin on Windows with empty Path", () => {
    const home = makeTempDir("kimi-bin-win-official-");
    const officialBin = join(home, ".kimi-code", "bin");
    mkdirSync(officialBin, { recursive: true });
    // Windows existence checks use F_OK (not X_OK); a regular file is enough.
    writeFileSync(join(officialBin, "kimi.exe"), "fake-kimi-exe\n");
    expect(
      findKimiExecutableOnPath(
        { USERPROFILE: home, Path: "" },
        {
          platform: "win32",
          pathDelimiter: ";",
          // Windows has no login-shell PATH fallback in production either.
          loginShellPathDirs: () => [],
        },
      ),
    ).toBe(join(officialBin, "kimi.exe"));
  });
});

describe("kimi binary missing helpers", () => {
  it("formatKimiBinaryMissingMessage names the official package and /login", () => {
    const message = formatKimiBinaryMissingMessage("not found");
    expect(message).toContain(KIMI_CLI_PACKAGE);
    expect(message).toContain("`kimi`");
    expect(message).toContain("`/login`");
    expect(message).toContain("Original error: not found");
  });

  it("isKimiBinaryMissingError matches formatted missing copy", () => {
    expect(isKimiBinaryMissingError(formatKimiBinaryMissingMessage("x"))).toBe(true);
    expect(isKimiBinaryMissingError("unrelated")).toBe(false);
  });
});
