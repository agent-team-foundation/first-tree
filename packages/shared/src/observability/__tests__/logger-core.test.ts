import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createLoggerOutputStream, LOG_REDACT_CENSOR, LOG_REDACT_PATHS } from "../logger-core.js";

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

describe("createLoggerOutputStream", () => {
  it("defaults to process.stderr when no destination is provided", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    try {
      const stream = createLoggerOutputStream({ getFormat: () => "json" });
      stream.write(`${JSON.stringify({ level: 30, time: "t", msg: "hi" })}\n`);
      expect(stderrSpy).toHaveBeenCalled();
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });

  it("writes to the destination returned by getDestination", () => {
    const { dest, read } = collect();
    const stream = createLoggerOutputStream({
      getFormat: () => "json",
      getDestination: () => dest,
    });
    stream.write(`${JSON.stringify({ level: 30, time: "t", msg: "hi" })}\n`);
    expect(read()).toContain('"msg":"hi"');
  });

  it("re-evaluates getDestination on every write so targets can be swapped", () => {
    const a = collect();
    const b = collect();
    let current = a.dest;
    const stream = createLoggerOutputStream({
      getFormat: () => "json",
      getDestination: () => current,
    });
    stream.write(`${JSON.stringify({ level: 30, time: "t", msg: "one" })}\n`);
    current = b.dest;
    stream.write(`${JSON.stringify({ level: 30, time: "t", msg: "two" })}\n`);
    expect(a.read()).toContain('"msg":"one"');
    expect(a.read()).not.toContain('"msg":"two"');
    expect(b.read()).toContain('"msg":"two"');
    expect(b.read()).not.toContain('"msg":"one"');
  });

  it("applies pretty formatting when format=pretty", () => {
    const { dest, read } = collect();
    const stream = createLoggerOutputStream({
      getFormat: () => "pretty",
      getDestination: () => dest,
    });
    stream.write(`${JSON.stringify({ level: 30, time: "t", msg: "hi", module: "M" })}\n`);
    const out = read();
    expect(out).toContain("INFO");
    expect(out).toContain("[M]");
    expect(out).toContain("hi");
  });
});

describe("LOG_REDACT_PATHS", () => {
  it("covers the obvious sensitive field names", () => {
    const paths = [...LOG_REDACT_PATHS];
    for (const name of ["password", "token", "accessToken", "jwt", "secret", "apiKey", "authorization"]) {
      expect(paths).toContain(name);
      expect(paths).toContain(`*.${name}`);
    }
  });

  it("has a stable censor string consumers can rely on", () => {
    expect(LOG_REDACT_CENSOR).toBe("[REDACTED]");
  });
});
