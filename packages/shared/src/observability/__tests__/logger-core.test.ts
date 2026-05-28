import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createLoggerOutputStream,
  formatLocalTime,
  formatPrettyEntry,
  LOG_REDACT_CENSOR,
  LOG_REDACT_PATHS,
  parseLogLevel,
} from "../logger-core.js";

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

  it("invokes onJsonEntry for JSON records and ignores non-JSON records", () => {
    const { dest } = collect();
    const seen: Array<Record<string, unknown>> = [];
    const stream = createLoggerOutputStream({
      getFormat: () => "json",
      getDestination: () => dest,
      onJsonEntry: (entry) => seen.push(entry),
    });

    stream.write(`${JSON.stringify({ level: 30, msg: "one" })}\n`);
    stream.write("not json\n");

    expect(seen).toEqual([{ level: 30, msg: "one" }]);
  });

  it("falls back to raw text when pretty formatting fails", () => {
    const chunks: string[] = [];
    const dest = new Writable();
    const write = vi.spyOn(dest, "write").mockImplementationOnce(((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as never);
    const stream = createLoggerOutputStream({
      getFormat: () => "pretty",
      getDestination: () => dest,
    });

    stream.write("not json\n");

    expect(write).toHaveBeenCalledTimes(1);
    expect(chunks).toEqual(["not json\n"]);
  });
});

describe("parseLogLevel", () => {
  it("parses known levels and falls back for empty or unknown values", () => {
    expect(parseLogLevel("debug")).toEqual({ level: "debug", fellBack: false });
    expect(parseLogLevel(undefined)).toEqual({ level: "info", fellBack: false });
    expect(parseLogLevel(null)).toEqual({ level: "info", fellBack: false });
    expect(parseLogLevel("verbose")).toEqual({ level: "info", fellBack: true });
  });
});

describe("formatPrettyEntry", () => {
  it("formats fallback labels, extras, and error stack details", () => {
    const out = formatPrettyEntry(
      JSON.stringify({
        level: 99,
        msg: "failed",
        requestId: "req-1",
        count: 2,
        err: { message: "boom", stack: "Error: boom\n    at test" },
      }),
    );

    expect(out).toContain("???");
    expect(out).toContain("failed");
    expect(out).toContain("requestId=req-1");
    expect(out).toContain("count=2");
    expect(out).toContain("err.message=boom");
    expect(out).toContain("Error: boom");
  });

  it("uses a generated timestamp and empty message when fields are omitted", () => {
    const out = formatPrettyEntry(JSON.stringify({ level: 30 }));

    expect(out).toContain("INFO");
    expect(out).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe("formatLocalTime", () => {
  it("returns a local date and time string", () => {
    expect(formatLocalTime()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
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
