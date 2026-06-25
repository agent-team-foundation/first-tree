import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveClaudeCodeExecutable } from "../handlers/claude-executable.js";

/** No login-shell dirs — keeps the existing cases hermetic (no real shell spawn). */
const noLoginShell = () => [];

let binDir: string;
let fakeClaude: string;
/** HOME with no well-known install dirs — isolates tests from the dev machine's real ~/.local/bin/claude. */
let emptyHome: string;

beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "ftt-claude-exec-"));
  fakeClaude = join(binDir, "claude");
  writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n");
  chmodSync(fakeClaude, 0o755);
  emptyHome = mkdtempSync(join(tmpdir(), "ftt-claude-home-"));
});

afterAll(() => {
  rmSync(binDir, { recursive: true, force: true });
  rmSync(emptyHome, { recursive: true, force: true });
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: "linux" });
});

describe("resolveClaudeCodeExecutable", () => {
  it("returns the env override when CLAUDE_CODE_EXECUTABLE points to an existing file", () => {
    const resolution = resolveClaudeCodeExecutable({
      env: { CLAUDE_CODE_EXECUTABLE: fakeClaude, PATH: "" },
    });
    expect(resolution).toEqual({ path: fakeClaude, source: "env" });
  });

  it("falls through to PATH lookup when the env override does not exist", () => {
    const resolution = resolveClaudeCodeExecutable({
      env: { CLAUDE_CODE_EXECUTABLE: join(binDir, "nonexistent"), PATH: binDir },
    });
    expect(resolution).toEqual({ path: fakeClaude, source: "path" });
  });

  it("finds `claude` on PATH when the env override is absent", () => {
    const resolution = resolveClaudeCodeExecutable({
      env: { PATH: `${join(binDir, "missing")}${delimiter}${binDir}` },
    });
    expect(resolution).toEqual({ path: fakeClaude, source: "path" });
  });

  it("skips empty PATH entries", () => {
    const resolution = resolveClaudeCodeExecutable({
      env: { PATH: `${delimiter}${binDir}` },
    });

    expect(resolution).toEqual({ path: fakeClaude, source: "path" });
  });

  it("returns the default sentinel when nothing is found", () => {
    const resolution = resolveClaudeCodeExecutable({
      env: { PATH: join(tmpdir(), "definitely-not-a-real-bin-dir-xyz"), HOME: emptyHome },
      loginShellPathDirs: noLoginShell,
    });
    expect(resolution).toEqual({ path: undefined, source: "default" });
  });

  it("returns the default sentinel when PATH is empty", () => {
    const resolution = resolveClaudeCodeExecutable({ env: { HOME: emptyHome }, loginShellPathDirs: noLoginShell });
    expect(resolution).toEqual({ path: undefined, source: "default" });
  });

  it("falls back to ~/.local/bin/claude when PATH misses it (well-known dir)", () => {
    const home = mkdtempSync(join(tmpdir(), "ftt-claude-wk-"));
    try {
      const wkClaude = join(home, ".local", "bin", "claude");
      mkdirSync(join(home, ".local", "bin"), { recursive: true });
      writeFileSync(wkClaude, "#!/bin/sh\nexit 0\n");
      chmodSync(wkClaude, 0o755);

      const resolution = resolveClaudeCodeExecutable({
        env: { PATH: "", HOME: home },
        loginShellPathDirs: noLoginShell,
      });

      expect(resolution).toEqual({ path: wkClaude, source: "well-known" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("prefers a PATH hit over the well-known dirs", () => {
    const home = mkdtempSync(join(tmpdir(), "ftt-claude-wk2-"));
    try {
      mkdirSync(join(home, ".local", "bin"), { recursive: true });
      writeFileSync(join(home, ".local", "bin", "claude"), "#!/bin/sh\nexit 0\n");

      const resolution = resolveClaudeCodeExecutable({ env: { PATH: binDir, HOME: home } });

      expect(resolution).toEqual({ path: fakeClaude, source: "path" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("checks the `claude migrate-installer` target (~/.claude/local/claude)", () => {
    const home = mkdtempSync(join(tmpdir(), "ftt-claude-wk3-"));
    try {
      const migrated = join(home, ".claude", "local", "claude");
      mkdirSync(join(home, ".claude", "local"), { recursive: true });
      writeFileSync(migrated, "#!/bin/sh\nexit 0\n");

      const resolution = resolveClaudeCodeExecutable({
        env: { PATH: "", HOME: home },
        loginShellPathDirs: noLoginShell,
      });

      expect(resolution).toEqual({ path: migrated, source: "well-known" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("searches default Windows PATHEXT entries when PATHEXT is absent", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const cmdClaude = join(binDir, "claude.CMD");
    writeFileSync(cmdClaude, "@echo off\r\nexit /b 0\r\n");

    const resolution = resolveClaudeCodeExecutable({
      env: { PATH: binDir },
    });

    expect(resolution).toEqual({ path: cmdClaude, source: "path" });
  });

  it("searches custom Windows PATHEXT entries and the bare executable name", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const psClaude = join(binDir, "claude.PS1");
    writeFileSync(psClaude, "exit 0\n");

    const resolution = resolveClaudeCodeExecutable({
      env: { PATH: binDir, PATHEXT: ".PS1;" },
    });

    expect(resolution).toEqual({ path: psClaude, source: "path" });
  });

  it("uses the bare executable name when Windows PATHEXT has no entries", () => {
    Object.defineProperty(process, "platform", { value: "win32" });

    const resolution = resolveClaudeCodeExecutable({
      env: { PATH: binDir, PATHEXT: ";" },
    });

    expect(resolution).toEqual({ path: fakeClaude, source: "path" });
  });

  it("finds `claude` via a login-shell-only PATH dir (source: path)", () => {
    const resolution = resolveClaudeCodeExecutable({
      env: { PATH: "", HOME: emptyHome },
      loginShellPathDirs: () => [join(tmpdir(), "missing-xyz"), binDir],
    });
    expect(resolution).toEqual({ path: fakeClaude, source: "path" });
  });

  it("does not spawn the login-shell probe when the daemon PATH already resolves `claude`", () => {
    const loginShellPathDirs = vi.fn(() => []);
    const resolution = resolveClaudeCodeExecutable({ env: { PATH: binDir }, loginShellPathDirs });
    expect(resolution).toEqual({ path: fakeClaude, source: "path" });
    expect(loginShellPathDirs).not.toHaveBeenCalled();
  });

  it("finds `claude` via a new Part-A well-known dir (~/.npm-global/bin)", () => {
    const home = mkdtempSync(join(tmpdir(), "ftt-claude-npmg-"));
    try {
      const wk = join(home, ".npm-global", "bin", "claude");
      mkdirSync(join(home, ".npm-global", "bin"), { recursive: true });
      writeFileSync(wk, "#!/bin/sh\nexit 0\n");
      chmodSync(wk, 0o755);

      const resolution = resolveClaudeCodeExecutable({
        env: { PATH: "", HOME: home },
        loginShellPathDirs: noLoginShell,
      });

      expect(resolution).toEqual({ path: wk, source: "well-known" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("prefers the daemon PATH over a login-shell dir that also has `claude`", () => {
    const resolution = resolveClaudeCodeExecutable({
      env: { PATH: binDir },
      loginShellPathDirs: () => [binDir],
    });
    expect(resolution).toEqual({ path: fakeClaude, source: "path" });
  });
});
