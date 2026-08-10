import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findGrokExecutableOnPath,
  formatGrokBinaryMissingMessage,
  GROK_INSTALL_COMMAND,
  isGrokBinaryMissingError,
  isGrokVersionSupported,
  parseGrokVersion,
  resolveGrokRuntimeBinary,
  verifyGrokExecutable,
} from "../binary.js";

let dir: string;

function makeExecutable(path: string, body = "#!/bin/sh\nexit 0\n"): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grok-binary-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("findGrokExecutableOnPath — external-only resolution", () => {
  it("resolves `grok` from the daemon PATH", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    makeExecutable(join(bin, "grok"));
    const found = findGrokExecutableOnPath(
      { PATH: bin, HOME: dir },
      { wellKnownDirs: () => [], loginShellPathDirs: () => [] },
    );
    expect(found).toBe(join(bin, "grok"));
  });

  it("falls back to the official `~/.grok/bin` install location when PATH misses", () => {
    const grokBin = join(dir, ".grok", "bin");
    mkdirSync(grokBin, { recursive: true });
    makeExecutable(join(grokBin, "grok"));
    // No wellKnownDirs injection: the default list must cover the official
    // installer's `~/.grok/bin` target.
    const found = findGrokExecutableOnPath({ PATH: join(dir, "nope"), HOME: dir }, { loginShellPathDirs: () => [] });
    expect(found).toBe(join(grokBin, "grok"));
  });

  it("falls back to the `~/.local/bin` symlink location", () => {
    const localBin = join(dir, ".local", "bin");
    mkdirSync(localBin, { recursive: true });
    makeExecutable(join(localBin, "grok"));
    const found = findGrokExecutableOnPath({ PATH: join(dir, "nope"), HOME: dir }, { loginShellPathDirs: () => [] });
    expect(found).toBe(join(localBin, "grok"));
  });

  it("falls back to the login-shell PATH last", () => {
    const loginBin = join(dir, "login-bin");
    mkdirSync(loginBin);
    makeExecutable(join(loginBin, "grok"));
    const found = findGrokExecutableOnPath(
      { PATH: join(dir, "nope"), HOME: dir },
      { wellKnownDirs: () => [], loginShellPathDirs: () => [loginBin] },
    );
    expect(found).toBe(join(loginBin, "grok"));
  });

  it("ignores directories and non-executables named grok", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    mkdirSync(join(bin, "grok"));
    const found = findGrokExecutableOnPath(
      { PATH: bin, HOME: dir },
      { wellKnownDirs: () => [], loginShellPathDirs: () => [] },
    );
    expect(found).toBeNull();
  });

  it("returns null when nothing resolves anywhere", () => {
    expect(
      findGrokExecutableOnPath(
        { PATH: join(dir, "nope"), HOME: dir },
        { wellKnownDirs: () => [], loginShellPathDirs: () => [] },
      ),
    ).toBeNull();
  });
});

describe("verifyGrokExecutable — version parse + supported-range gate", () => {
  const fakeGrok = (versionLine: string): string => {
    const path = join(dir, `grok-${versionLine.replaceAll(/[^a-z0-9]+/gi, "-")}`);
    makeExecutable(path, `#!/bin/sh\necho '${versionLine}'\nexit 0\n`);
    return path;
  };

  it("parses the canonical `grok 0.2.117 (f1c06093089f)` output", () => {
    expect(parseGrokVersion("grok 0.2.117 (f1c06093089f)")).toBe("0.2.117");
    expect(parseGrokVersion("grok 0.2.117 (f1c06093089f)\n")).toBe("0.2.117");
    expect(parseGrokVersion("some other tool 1.2.3")).toBeNull();
  });

  it("accepts a binary at the supported floor 0.2.117", () => {
    const verification = verifyGrokExecutable(fakeGrok("grok 0.2.117 (f1c06093089f)"));
    expect(verification).toMatchObject({ ok: true, version: "0.2.117" });
  });

  it("accepts a newer 0.2.x binary inside the range", () => {
    const verification = verifyGrokExecutable(fakeGrok("grok 0.2.140 (abcd1234)"));
    expect(verification).toMatchObject({ ok: true, version: "0.2.140" });
  });

  it("rejects 0.2.89 (below the floor) as deterministic, NOT transient", () => {
    const verification = verifyGrokExecutable(fakeGrok("grok 0.2.89 (abcd1234)"));
    expect(verification.ok).toBe(false);
    if (verification.ok) throw new Error("unreachable");
    expect(verification.transient).toBe(false);
    expect(verification.reason).toContain("0.2.89");
    expect(verification.reason).toContain("outside the supported range");
  });

  it("rejects 0.3.0 (the exclusive ceiling) as deterministic, NOT transient", () => {
    const verification = verifyGrokExecutable(fakeGrok("grok 0.3.0 (abcd1234)"));
    expect(verification.ok).toBe(false);
    if (verification.ok) throw new Error("unreachable");
    expect(verification.transient).toBe(false);
    expect(verification.reason).toContain("outside the supported range");
  });

  it("isGrokVersionSupported pins the exact range boundaries", () => {
    expect(isGrokVersionSupported("0.2.116")).toBe(false);
    expect(isGrokVersionSupported("0.2.117")).toBe(true);
    expect(isGrokVersionSupported("0.2.999")).toBe(true);
    expect(isGrokVersionSupported("0.3.0")).toBe(false);
    expect(isGrokVersionSupported("1.0.0")).toBe(false);
  });

  it("a clean exit with unparseable output is deterministic, NOT transient", () => {
    const verification = verifyGrokExecutable(fakeGrok("hello world"));
    expect(verification.ok).toBe(false);
    if (verification.ok) throw new Error("unreachable");
    expect(verification.transient).toBe(false);
    expect(verification.reason).toContain("did not report a parseable version");
  });

  it("a non-zero exit is deterministic, NOT transient", () => {
    const path = join(dir, "grok-broken");
    makeExecutable(path, "#!/bin/sh\necho 'boom' >&2\nexit 2\n");
    const verification = verifyGrokExecutable(path);
    expect(verification.ok).toBe(false);
    if (verification.ok) throw new Error("unreachable");
    expect(verification.transient).toBe(false);
    expect(verification.reason).toContain("exited 2");
  });
});

describe("resolveGrokRuntimeBinary — spawn-time smoke split", () => {
  it("win32 → refuses BEFORE any filesystem consult (central no-spawn gate)", () => {
    const findOnPath = vi.fn(() => "/fake/grok");
    const resolution = resolveGrokRuntimeBinary({ HOME: dir }, { platform: "win32", findOnPath });
    expect(resolution).toMatchObject({ ok: false, transient: false });
    if (resolution.ok) throw new Error("unreachable");
    expect(resolution.error).toContain("not supported on Windows in V1");
    expect(findOnPath).not.toHaveBeenCalled();
  });

  it("missing binary → non-transient error carrying the official installer command", () => {
    const resolution = resolveGrokRuntimeBinary({ PATH: join(dir, "nope"), HOME: dir }, { findOnPath: () => null });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error("unreachable");
    expect(resolution.transient).toBe(false);
    expect(resolution.error).toContain(GROK_INSTALL_COMMAND);
    expect(isGrokBinaryMissingError(new Error(resolution.error))).toBe(true);
  });

  it("resolved binary whose smoke check flakes transiently is NOT missing (and is not cached)", () => {
    // Distinct fake path per case: successful verifications are memoized per
    // binary path, so sharing a path across cases would couple test order.
    const resolution = resolveGrokRuntimeBinary(
      { HOME: dir },
      {
        findOnPath: () => "/fake/transient/grok",
        verifyPath: () => ({ ok: false, transient: true, reason: "`grok --version` timed out" }),
      },
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error("unreachable");
    expect(resolution.transient).toBe(true);
    expect(resolution.error).not.toMatch(/is missing/i);
  });

  it("clean broken-binary verdict is permanent and does NOT read as missing", () => {
    const resolution = resolveGrokRuntimeBinary(
      { HOME: dir },
      {
        findOnPath: () => "/fake/broken/grok",
        verifyPath: () => ({ ok: false, transient: false, reason: "`grok --version` exited 2" }),
      },
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error("unreachable");
    expect(resolution.transient).toBe(false);
    // "missing" is only for "no binary resolved" — a present-but-broken
    // binary is an unsupported verdict with a deterministic classification.
    expect(resolution.error).toContain("is not a supported Grok Build version");
    expect(resolution.error).not.toMatch(/is missing/i);
    expect(isGrokBinaryMissingError(new Error(resolution.error))).toBe(false);
  });

  it("an out-of-range version is permanent and names the supported range", () => {
    const resolution = resolveGrokRuntimeBinary(
      { HOME: dir },
      {
        findOnPath: () => "/fake/old/grok",
        verifyPath: () => ({
          ok: false,
          transient: false,
          reason: "grok 0.2.89 is outside the supported range >=0.2.117 <0.3.0",
        }),
      },
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error("unreachable");
    expect(resolution.transient).toBe(false);
    expect(resolution.error).toContain("outside the supported range");
    expect(resolution.error).not.toMatch(/is missing/i);
    expect(isGrokBinaryMissingError(new Error(resolution.error))).toBe(false);
  });

  it("verified binary reports the parsed version and memoizes the blocking smoke check", () => {
    const verify = vi.fn(() => ({ ok: true as const, output: "grok 0.2.117 (f1c06093089f)", version: "0.2.117" }));
    const deps = { findOnPath: () => "/fake/verified/grok", verifyPath: verify };
    const resolution = resolveGrokRuntimeBinary({ HOME: dir }, deps);
    expect(resolution).toMatchObject({
      ok: true,
      binary: "/fake/verified/grok",
      version: "0.2.117",
    });
    // Second resolve of the same path must not spawn `--version` again.
    const again = resolveGrokRuntimeBinary({ HOME: dir }, deps);
    expect(again).toMatchObject({ ok: true, version: "0.2.117" });
    expect(verify).toHaveBeenCalledTimes(1);
  });
});

describe("formatGrokBinaryMissingMessage", () => {
  it("names the external-only posture and the official installer", () => {
    const message = formatGrokBinaryMissingMessage("nothing resolved");
    expect(message).toContain("does not bundle or install the Grok engine");
    expect(message).toContain(GROK_INSTALL_COMMAND);
    expect(message).toContain("grok login");
    expect(message).toContain("nothing resolved");
  });
});
