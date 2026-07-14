import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CURSOR_INSTALL_COMMAND,
  findCursorExecutableOnPath,
  formatCursorBinaryMissingMessage,
  isCursorBinaryMissingError,
  resolveCursorRuntimeBinary,
} from "../runtime/cursor-binary.js";

let dir: string;

function makeExecutable(path: string): void {
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cursor-binary-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("findCursorExecutableOnPath — external-only resolution", () => {
  it("resolves `cursor-agent` from the daemon PATH", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    makeExecutable(join(bin, "cursor-agent"));
    const found = findCursorExecutableOnPath(
      { PATH: bin, HOME: dir },
      { wellKnownDirs: () => [], loginShellPathDirs: () => [] },
    );
    expect(found).toBe(join(bin, "cursor-agent"));
  });

  it("prefers `cursor-agent` ANYWHERE over an `agent` earlier on PATH", () => {
    // A machine with an unrelated `agent` on PATH must still resolve the real
    // Cursor CLI from a well-known install dir.
    const pathDir = join(dir, "path-bin");
    const wellKnown = join(dir, "local-bin");
    mkdirSync(pathDir);
    mkdirSync(wellKnown);
    makeExecutable(join(pathDir, "agent"));
    makeExecutable(join(wellKnown, "cursor-agent"));
    const found = findCursorExecutableOnPath(
      { PATH: pathDir, HOME: dir },
      { wellKnownDirs: () => [wellKnown], loginShellPathDirs: () => [] },
    );
    expect(found).toBe(join(wellKnown, "cursor-agent"));
  });

  it("falls back to the official `agent` command when no cursor-agent exists", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    makeExecutable(join(bin, "agent"));
    const found = findCursorExecutableOnPath(
      { PATH: bin, HOME: dir },
      { wellKnownDirs: () => [], loginShellPathDirs: () => [] },
    );
    expect(found).toBe(join(bin, "agent"));
  });

  it("ignores directories and non-executables named cursor-agent", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    mkdirSync(join(bin, "cursor-agent"));
    const found = findCursorExecutableOnPath(
      { PATH: bin, HOME: dir },
      { wellKnownDirs: () => [], loginShellPathDirs: () => [] },
    );
    expect(found).toBeNull();
  });

  it("returns null when nothing resolves anywhere", () => {
    expect(
      findCursorExecutableOnPath(
        { PATH: join(dir, "nope"), HOME: dir },
        { wellKnownDirs: () => [], loginShellPathDirs: () => [] },
      ),
    ).toBeNull();
  });
});

describe("resolveCursorRuntimeBinary — spawn-time smoke split", () => {
  it("missing binary → non-transient error carrying the official installer command", () => {
    const resolution = resolveCursorRuntimeBinary({ PATH: join(dir, "nope"), HOME: dir }, { findOnPath: () => null });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error("unreachable");
    expect(resolution.transient).toBe(false);
    expect(resolution.error).toContain(CURSOR_INSTALL_COMMAND);
    expect(isCursorBinaryMissingError(new Error(resolution.error))).toBe(true);
  });

  it("resolved binary whose smoke check flakes transiently is NOT missing (and is not cached)", () => {
    // Distinct fake path per case: successful verifications are memoized per
    // binary path, so sharing a path across cases would couple test order.
    const resolution = resolveCursorRuntimeBinary(
      { HOME: dir },
      {
        findOnPath: () => "/fake/transient/cursor-agent",
        verifyPath: () => ({ ok: false, transient: true, reason: "`cursor-agent --version` timed out" }),
      },
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error("unreachable");
    expect(resolution.transient).toBe(true);
    expect(resolution.error).not.toMatch(/is missing/i);
  });

  it("clean broken-binary verdict is permanent (capability failure copy)", () => {
    const resolution = resolveCursorRuntimeBinary(
      { HOME: dir },
      {
        findOnPath: () => "/fake/broken/cursor-agent",
        verifyPath: () => ({ ok: false, transient: false, reason: "`cursor-agent --version` exited 2" }),
      },
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error("unreachable");
    expect(resolution.transient).toBe(false);
    expect(resolution.error).toContain("Cursor Agent CLI is missing");
  });

  it("verified binary reports the parsed version and memoizes the blocking smoke check", () => {
    const verify = vi.fn(() => ({ ok: true as const, output: "2026.07.09-a3815c0" }));
    const deps = { findOnPath: () => "/fake/verified/cursor-agent", verifyPath: verify };
    const resolution = resolveCursorRuntimeBinary({ HOME: dir }, deps);
    expect(resolution).toMatchObject({
      ok: true,
      binary: "/fake/verified/cursor-agent",
      version: "2026.07.09-a3815c0",
    });
    // Second resolve of the same path must not spawn `--version` again.
    const again = resolveCursorRuntimeBinary({ HOME: dir }, deps);
    expect(again).toMatchObject({ ok: true, version: "2026.07.09-a3815c0" });
    expect(verify).toHaveBeenCalledTimes(1);
  });
});

describe("formatCursorBinaryMissingMessage", () => {
  it("names the external-only posture and the official installer", () => {
    const message = formatCursorBinaryMissingMessage("nothing resolved");
    expect(message).toContain("does not bundle or install the Cursor engine");
    expect(message).toContain(CURSOR_INSTALL_COMMAND);
    expect(message).toContain("cursor-agent login");
    expect(message).toContain("nothing resolved");
  });
});
