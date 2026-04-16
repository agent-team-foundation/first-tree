import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInjectContext } from "../src/products/tree/engine/commands/inject-context.js";

describe("runInjectContext", () => {
  let tmpDir: string;
  let originalCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let logged: string[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "inject-context-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    logged = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logged.push(args.join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits hook payload when NODE.md exists", () => {
    writeFileSync(join(tmpDir, "NODE.md"), "# Root\nbody\n");
    const code = runInjectContext([]);
    expect(code).toBe(0);
    expect(logged).toHaveLength(1);
    const payload = JSON.parse(logged[0]);
    expect(payload.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(payload.hookSpecificOutput.additionalContext).toBe("# Root\nbody\n");
  });

  it("is silent when NODE.md is absent", () => {
    const code = runInjectContext([]);
    expect(code).toBe(0);
    expect(logged).toHaveLength(0);
  });

  it("escapes special characters via JSON.stringify", () => {
    writeFileSync(join(tmpDir, "NODE.md"), 'has "quotes" and\nnewlines\tand\\backslash');
    const code = runInjectContext([]);
    expect(code).toBe(0);
    const payload = JSON.parse(logged[0]);
    expect(payload.hookSpecificOutput.additionalContext).toBe(
      'has "quotes" and\nnewlines\tand\\backslash',
    );
  });

  it("prints help with --help", () => {
    const code = runInjectContext(["--help"]);
    expect(code).toBe(0);
    expect(logged.join("\n")).toContain("first-tree inject-context");
  });
});
