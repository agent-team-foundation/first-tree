import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBuiltinHandlers } from "../handlers/index.js";
import { applyClientLoggerConfig } from "../observability/logger.js";
import { getHandlerFactory } from "../runtime/handler.js";

function collectLogs(): { dest: Writable; read: () => string } {
  const chunks: string[] = [];
  const dest = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { dest, read: () => chunks.join("") };
}

describe("Built-in Handlers", () => {
  afterEach(() => {
    applyClientLoggerConfig({ level: "silent", format: "json", destination: process.stderr, explicit: false });
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

  it("registers cursor handler with a valid session-oriented shape", () => {
    registerBuiltinHandlers();

    const factory = getHandlerFactory("cursor");
    expect(typeof factory).toBe("function");
    const handler = factory({ workspaceRoot: "/tmp/test" });
    expect(typeof handler.start).toBe("function");
    expect(typeof handler.resume).toBe("function");
    expect(typeof handler.inject).toBe("function");
    expect(typeof handler.suspend).toBe("function");
    expect(typeof handler.shutdown).toBe("function");
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
    const { dest, read } = collectLogs();
    applyClientLoggerConfig({ level: "info", format: "json", destination: dest });

    // Inject a resolver that finds nothing — hermetic against the dev machine's
    // real PATH / well-known install dirs and any login-shell probe.
    registerBuiltinHandlers({ resolveExecutable: () => ({ path: undefined, source: "default" }) });

    expect(read()).toContain('"module":"handlers"');
    expect(read()).toContain("using SDK bundled native binary");
  });
});
