import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyClientLoggerConfig, createLogger } from "../logger.js";

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
});
