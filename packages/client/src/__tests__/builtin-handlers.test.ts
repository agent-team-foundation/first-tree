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

  it("registers claude-code-tui handler", () => {
    registerBuiltinHandlers();

    const factory = getHandlerFactory("claude-code-tui");
    expect(factory).toBeDefined();
    expect(typeof factory).toBe("function");
  });

  it("claude-code-tui factory returns a valid session-oriented handler", () => {
    registerBuiltinHandlers();

    const factory = getHandlerFactory("claude-code-tui");
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
    const stderrMessages: string[] = [];
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((message: string | Uint8Array) => {
      stderrMessages.push(String(message));
      return true;
    });
    try {
      // Inject a resolver that finds nothing — hermetic against the dev machine's
      // real PATH / well-known install dirs and any login-shell probe.
      registerBuiltinHandlers({ resolveExecutable: () => ({ path: undefined, source: "default" }) });
    } finally {
      stderrWrite.mockRestore();
    }

    expect(stderrMessages.join("")).toContain("using SDK bundled native binary");
  });
});
