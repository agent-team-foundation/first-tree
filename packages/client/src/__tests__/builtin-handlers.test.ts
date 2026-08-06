import { Writable } from "node:stream";
import { RUNTIME_PROVIDER_IDS } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyClientLoggerConfig } from "../observability/logger.js";
import { createBuiltinHandlerRegistry, resolveAndLogClaudeExecutable } from "../providers/builtin-registry.js";

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

  for (const id of RUNTIME_PROVIDER_IDS) {
    it(`${id} factory returns a valid session-oriented handler`, () => {
      const registry = createBuiltinHandlerRegistry({
        resolveExecutable: () => ({ path: undefined, source: "default" }),
      });
      const factory = registry[id];
      expect(typeof factory).toBe("function");
      const handler = factory({
        runtimeProvider: id,
        workspaceRoot: "/tmp/test",
      });
      expect(typeof handler.start).toBe("function");
      expect(typeof handler.resume).toBe("function");
      expect(typeof handler.inject).toBe("function");
      expect(typeof handler.suspend).toBe("function");
      expect(typeof handler.shutdown).toBe("function");
    });
  }

  it("logs the SDK bundled binary fallback when no Claude executable is resolved", () => {
    const { dest, read } = collectLogs();
    applyClientLoggerConfig({ level: "info", format: "json", destination: dest });

    // Inject a resolver that finds nothing — hermetic against the dev machine's
    // real PATH / well-known install dirs and any login-shell probe.
    resolveAndLogClaudeExecutable({ resolveExecutable: () => ({ path: undefined, source: "default" }) });

    expect(read()).toContain('"module":"handlers"');
    expect(read()).toContain("using SDK bundled native binary");
  });
});
