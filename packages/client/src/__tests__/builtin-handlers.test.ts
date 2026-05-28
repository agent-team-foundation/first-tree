import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBuiltinHandlers } from "../handlers/index.js";
import { getHandlerFactory } from "../runtime/handler.js";

describe("Built-in Handlers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers claude-code handler", () => {
    registerBuiltinHandlers();

    const factory = getHandlerFactory("claude-code");
    expect(factory).toBeDefined();
    expect(typeof factory).toBe("function");
  });

  it("claude-code factory returns a valid session-oriented handler", () => {
    registerBuiltinHandlers();

    const factory = getHandlerFactory("claude-code");
    const handler = factory({ workspaceRoot: "/tmp/test" });
    expect(handler).toBeDefined();
    expect(typeof handler.start).toBe("function");
    expect(typeof handler.resume).toBe("function");
    expect(typeof handler.inject).toBe("function");
    expect(typeof handler.suspend).toBe("function");
    expect(typeof handler.shutdown).toBe("function");
  });

  it("registers codex handler", () => {
    registerBuiltinHandlers();

    const factory = getHandlerFactory("codex");
    expect(factory).toBeDefined();
    expect(typeof factory).toBe("function");
  });

  it("codex factory returns a valid session-oriented handler", () => {
    registerBuiltinHandlers();

    const factory = getHandlerFactory("codex");
    const handler = factory({ workspaceRoot: "/tmp/test" });
    expect(handler).toBeDefined();
    expect(typeof handler.start).toBe("function");
    expect(typeof handler.resume).toBe("function");
    expect(typeof handler.inject).toBe("function");
    expect(typeof handler.suspend).toBe("function");
    expect(typeof handler.shutdown).toBe("function");
  });

  it("logs the SDK bundled binary fallback when no Claude executable is resolved", () => {
    const originalEnv = {
      CLAUDE_CODE_EXECUTABLE: process.env.CLAUDE_CODE_EXECUTABLE,
      PATH: process.env.PATH,
      Path: process.env.Path,
      path: process.env.path,
    };
    const stderrMessages: string[] = [];
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((message: string | Uint8Array) => {
      stderrMessages.push(String(message));
      return true;
    });

    try {
      delete process.env.CLAUDE_CODE_EXECUTABLE;
      process.env.PATH = "";
      delete process.env.Path;
      delete process.env.path;

      registerBuiltinHandlers();
    } finally {
      if (originalEnv.CLAUDE_CODE_EXECUTABLE === undefined) {
        delete process.env.CLAUDE_CODE_EXECUTABLE;
      } else {
        process.env.CLAUDE_CODE_EXECUTABLE = originalEnv.CLAUDE_CODE_EXECUTABLE;
      }
      if (originalEnv.PATH === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalEnv.PATH;
      }
      if (originalEnv.Path === undefined) {
        delete process.env.Path;
      } else {
        process.env.Path = originalEnv.Path;
      }
      if (originalEnv.path === undefined) {
        delete process.env.path;
      } else {
        process.env.path = originalEnv.path;
      }
      stderrWrite.mockRestore();
    }

    expect(stderrMessages.join("")).toContain("using SDK bundled native binary");
  });
});
