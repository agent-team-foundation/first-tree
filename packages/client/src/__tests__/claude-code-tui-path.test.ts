import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tmuxOnPath } from "../runtime/capabilities/claude-code-tui.js";

describe("tmuxOnPath", () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "ft-tmux-path-"));
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("finds an executable tmux binary on PATH", () => {
    const binDir = join(tmpBase, "bin");
    mkdirSync(binDir);
    const binary = join(binDir, process.platform === "win32" ? "tmux.exe" : "tmux");
    writeFileSync(binary, "#!/bin/sh\n");
    if (process.platform !== "win32") chmodSync(binary, 0o755);

    expect(tmuxOnPath({ PATH: `${binDir}${delimiter}` })).toBe(true);
  });

  it("rejects missing, empty, and non-executable tmux PATH entries", () => {
    const emptyDir = join(tmpBase, "empty");
    const directoryCandidate = join(tmpBase, "dir-candidate");
    mkdirSync(emptyDir);
    mkdirSync(directoryCandidate);
    mkdirSync(join(directoryCandidate, process.platform === "win32" ? "tmux.exe" : "tmux"));

    expect(tmuxOnPath({})).toBe(false);
    expect(tmuxOnPath({ PATH: "" })).toBe(false);
    expect(tmuxOnPath({ PATH: `${emptyDir}${delimiter}${directoryCandidate}` })).toBe(false);
  });
});
