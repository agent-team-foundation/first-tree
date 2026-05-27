import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyClientLoggerConfig, configureClientLoggerForService, createLogger } from "../logger.js";

function collect(): { dest: Writable; read: () => string } {
  const chunks: string[] = [];
  const dest = new Writable({
    write(chunk, _, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { dest, read: () => chunks.join("") };
}

describe("client logger", () => {
  afterEach(() => {
    // `explicit: false` un-pins any sticky level set by the previous test so
    // state doesn't leak across cases.
    applyClientLoggerConfig({ level: "silent", format: "json", destination: process.stderr, explicit: false });
    vi.restoreAllMocks();
  });

  it("redacts common sensitive fields in JSON output", () => {
    const { dest, read } = collect();
    applyClientLoggerConfig({ level: "trace", format: "json", destination: dest });
    createLogger("test").info(
      {
        token: "abc123",
        accessToken: "xyz",
        jwt: "eyJ",
        password: "p",
        secret: "s",
        authorization: "Bearer t",
        nested: { token: "n", ok: "visible" },
        ok: "visible",
      },
      "hi",
    );
    const line = read();
    expect(line).toContain('"token":"[REDACTED]"');
    expect(line).toContain('"accessToken":"[REDACTED]"');
    expect(line).toContain('"jwt":"[REDACTED]"');
    expect(line).toContain('"password":"[REDACTED]"');
    expect(line).toContain('"secret":"[REDACTED]"');
    expect(line).toContain('"authorization":"[REDACTED]"');
    expect(line).toContain('"ok":"visible"');
    // Nested path: pino v9 `*.token` matches one nesting level.
    expect(line).toContain('"nested":');
    expect(line).not.toMatch(/"token":"n"/);
  });

  it("explicit level sticks across subsequent non-explicit applies", () => {
    const { dest } = collect();
    applyClientLoggerConfig({ level: "debug", destination: dest, explicit: true });
    // Simulate `client start` applying its config-sourced level; the CLI
    // override must win.
    applyClientLoggerConfig({ level: "info" });
    const logger = createLogger("test");
    expect(logger.level).toBe("debug");
  });

  it("non-explicit level gives way to later non-explicit applies", () => {
    const { dest } = collect();
    applyClientLoggerConfig({ level: "debug", destination: dest });
    applyClientLoggerConfig({ level: "info" });
    const logger = createLogger("test");
    expect(logger.level).toBe("info");
  });

  it("does not write to process.stdout at any log level", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    const { dest } = collect();
    try {
      applyClientLoggerConfig({ level: "trace", format: "pretty", destination: dest });
      createLogger("test").trace("t");
      createLogger("test").debug("d");
      createLogger("test").info("i");
      createLogger("test").warn("w");
      createLogger("test").error("e");
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("configures a JSON rotating file sink for service mode", () => {
    const logDir = mkdtempSync(join(tmpdir(), "ftt-service-logs-"));
    try {
      configureClientLoggerForService(logDir);
      applyClientLoggerConfig({ level: "info" });

      createLogger("service-test").info({ visible: true }, "service ready");

      const line = readFileSync(join(logDir, "client.log"), "utf8");
      expect(line).toContain('"module":"service-test"');
      expect(line).toContain('"msg":"service ready"');
      expect(line).toContain('"visible":true');
    } finally {
      applyClientLoggerConfig({ level: "silent", format: "json", destination: process.stderr, explicit: false });
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it("loads silent defaults in test mode when no log level is set", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalLogLevel = process.env.FIRST_TREE_LOG_LEVEL;

    try {
      vi.resetModules();
      process.env.NODE_ENV = "test";
      delete process.env.FIRST_TREE_LOG_LEVEL;

      const mod = await import("../logger.js");

      expect(mod.createLogger("reload-test").level).toBe("silent");
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
      if (originalLogLevel === undefined) {
        delete process.env.FIRST_TREE_LOG_LEVEL;
      } else {
        process.env.FIRST_TREE_LOG_LEVEL = originalLogLevel;
      }
      vi.resetModules();
    }
  });

  it("uses JSON defaults in production mode", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalLogLevel = process.env.FIRST_TREE_LOG_LEVEL;
    const { dest, read } = collect();

    try {
      vi.resetModules();
      process.env.NODE_ENV = "production";
      delete process.env.FIRST_TREE_LOG_LEVEL;

      const mod = await import("../logger.js");
      mod.applyClientLoggerConfig({ level: "info", destination: dest });
      mod.createLogger("reload-test").info("json default");

      expect(read()).toContain('"msg":"json default"');
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
      if (originalLogLevel === undefined) {
        delete process.env.FIRST_TREE_LOG_LEVEL;
      } else {
        process.env.FIRST_TREE_LOG_LEVEL = originalLogLevel;
      }
      vi.resetModules();
    }
  });

  it("warns once when FIRST_TREE_LOG_LEVEL is invalid at module load", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalLogLevel = process.env.FIRST_TREE_LOG_LEVEL;
    const stderrMessages: string[] = [];
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((message: string | Uint8Array) => {
      stderrMessages.push(String(message));
      return true;
    });

    try {
      vi.resetModules();
      process.env.NODE_ENV = "test";
      process.env.FIRST_TREE_LOG_LEVEL = "definitely-invalid";

      await import("../logger.js");

      expect(stderrMessages.join("")).toContain("invalid FIRST_TREE_LOG_LEVEL");
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
      if (originalLogLevel === undefined) {
        delete process.env.FIRST_TREE_LOG_LEVEL;
      } else {
        process.env.FIRST_TREE_LOG_LEVEL = originalLogLevel;
      }
      stderrWrite.mockRestore();
      vi.resetModules();
    }
  });
});
