import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../handlers/claude-executable.js", () => ({
  resolveClaudeCodeExecutable: vi.fn(),
}));

vi.mock("../runtime/capabilities/claude-code.js", () => ({
  resolveBundledClaudeBinary: vi.fn(),
}));

import { resolveClaudeCodeExecutable } from "../handlers/claude-executable.js";
import { resolveBundledClaudeBinary } from "../runtime/capabilities/claude-code.js";
import { resolveClaudeLoginInvocation, runClaudeBrowserLogin } from "../runtime/claude-login.js";

const resolveExecutable = vi.mocked(resolveClaudeCodeExecutable);
const resolveBundled = vi.mocked(resolveBundledClaudeBinary);

describe("resolveClaudeLoginInvocation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("prefers an on-disk claude path resolution", () => {
    resolveExecutable.mockReturnValue({ path: "/usr/local/bin/claude", source: "path" });
    expect(resolveClaudeLoginInvocation({})).toEqual({
      ok: true,
      command: "/usr/local/bin/claude",
      baseArgs: [],
    });
    expect(resolveBundled).not.toHaveBeenCalled();
  });

  it("falls back to the bundled native binary when no on-disk claude exists", () => {
    resolveExecutable.mockReturnValue({ path: undefined, source: "default" });
    resolveBundled.mockReturnValue({ kind: "native", path: "/sdk/claude" });
    expect(resolveClaudeLoginInvocation({})).toEqual({
      ok: true,
      command: "/sdk/claude",
      baseArgs: [],
    });
  });

  it("runs legacy cli.js via process.execPath", () => {
    resolveExecutable.mockReturnValue({ path: undefined, source: "default" });
    resolveBundled.mockReturnValue({ kind: "cli-js", path: "/sdk/cli.js" });
    expect(resolveClaudeLoginInvocation({})).toEqual({
      ok: true,
      command: process.execPath,
      baseArgs: ["/sdk/cli.js"],
    });
  });

  it("returns a structured error when the bundle cannot be resolved", () => {
    resolveExecutable.mockReturnValue({ path: undefined, source: "default" });
    resolveBundled.mockImplementation(() => {
      throw new Error("bundle missing");
    });
    expect(resolveClaudeLoginInvocation({})).toEqual({
      ok: false,
      error: expect.stringContaining("bundle missing"),
    });
  });

  it("stringifies non-Error bundle failures", () => {
    resolveExecutable.mockReturnValue({ path: undefined, source: "default" });
    resolveBundled.mockImplementation(() => {
      throw "plain failure";
    });
    expect(resolveClaudeLoginInvocation({})).toEqual({
      ok: false,
      error: expect.stringContaining("plain failure"),
    });
  });
});

describe("runClaudeBrowserLogin", () => {
  it("spawns claude auth login with base args and succeeds on exit 0", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    const spawnFn = vi.fn(() => child);

    const pending = runClaudeBrowserLogin({
      command: "/bin/claude",
      baseArgs: ["--flag"],
      env: { PATH: "/bin" },
      spawnFn: spawnFn as never,
      timeoutMs: 1000,
      onRawOutput: vi.fn(),
    });

    expect(spawnFn).toHaveBeenCalledWith(
      "/bin/claude",
      ["--flag", "auth", "login"],
      expect.objectContaining({ env: { PATH: "/bin" } }),
    );
    setImmediate(() => child.emit("close", 0));
    await expect(pending).resolves.toEqual({ ok: true });
  });
});
