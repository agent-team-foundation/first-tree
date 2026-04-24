import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveClaudeCodeExecutable } from "../handlers/claude-executable.js";

let binDir: string;
let fakeClaude: string;

beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "ftt-claude-exec-"));
  fakeClaude = join(binDir, "claude");
  writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n");
  chmodSync(fakeClaude, 0o755);
});

afterAll(() => {
  rmSync(binDir, { recursive: true, force: true });
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

  it("returns the default sentinel when nothing is found", () => {
    const resolution = resolveClaudeCodeExecutable({
      env: { PATH: join(tmpdir(), "definitely-not-a-real-bin-dir-xyz") },
    });
    expect(resolution).toEqual({ path: undefined, source: "default" });
  });

  it("returns the default sentinel when PATH is empty", () => {
    const resolution = resolveClaudeCodeExecutable({ env: {} });
    expect(resolution).toEqual({ path: undefined, source: "default" });
  });
});
