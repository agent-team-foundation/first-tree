import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RotatingFileStream } from "../rotating-file-stream.js";

describe("RotatingFileStream", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rot-"));
  });

  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes to the primary path until maxBytes is reached", () => {
    const path = join(dir, "app.log");
    const s = new RotatingFileStream({ path, maxBytes: 100, maxFiles: 3 });
    s.write("line 1\n");
    s.write("line 2\n");
    s.end();
    expect(readFileSync(path, "utf8")).toBe("line 1\nline 2\n");
  });

  it("rotates once maxBytes is reached, preserving historical files", () => {
    const path = join(dir, "app.log");
    const s = new RotatingFileStream({ path, maxBytes: 20, maxFiles: 3 });
    s.write("aaaaaaaaaaaaaaaaaaaa\n"); // 21 bytes, triggers rotation
    s.write("bbb\n");
    s.end();
    // Active file holds post-rotation writes.
    expect(readFileSync(path, "utf8")).toBe("bbb\n");
    // .1 is the most recently rotated file.
    expect(readFileSync(`${path}.1`, "utf8")).toBe("aaaaaaaaaaaaaaaaaaaa\n");
  });

  it("shifts older rotated files up the numbered sequence and drops beyond maxFiles", () => {
    const path = join(dir, "app.log");
    // maxFiles=2 means we keep .1 and .2; a third rotation must evict the oldest.
    const s = new RotatingFileStream({ path, maxBytes: 10, maxFiles: 2 });
    s.write("AAAAAAAAAA\n"); // triggers rotation 1 → .1
    s.write("BBBBBBBBBB\n"); // triggers rotation 2: .1 → .2, new → .1
    s.write("CCCCCCCCCC\n"); // triggers rotation 3: .2 dropped, .1 → .2, new → .1
    s.end();
    expect(existsSync(`${path}.3`)).toBe(false);
    expect(readFileSync(`${path}.2`, "utf8")).toBe("BBBBBBBBBB\n");
    expect(readFileSync(`${path}.1`, "utf8")).toBe("CCCCCCCCCC\n");
  });

  it("continues from existing file size on reopen (append mode)", () => {
    const path = join(dir, "app.log");
    const a = new RotatingFileStream({ path, maxBytes: 100, maxFiles: 3 });
    a.write("first\n");
    a.end();
    const b = new RotatingFileStream({ path, maxBytes: 100, maxFiles: 3 });
    b.write("second\n");
    b.end();
    expect(readFileSync(path, "utf8")).toBe("first\nsecond\n");
    // Size is the appended total, not just the newest chunk.
    expect(statSync(path).size).toBe("first\nsecond\n".length);
  });

  it("accepts direct string chunks from Writable internals", () => {
    const path = join(dir, "app.log");
    const s = new RotatingFileStream({ path, maxBytes: 100, maxFiles: 3 });
    let callbackError: Error | null | undefined;

    s._write("raw string\n", "utf8", (err) => {
      callbackError = err;
    });
    s.end();

    expect(callbackError).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe("raw string\n");
  });

  it("passes write and final errors to the stream callbacks", async () => {
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      let closeCalls = 0;
      return {
        ...actual,
        writeSync: () => {
          throw "write failed";
        },
        closeSync: () => {
          closeCalls += 1;
          if (closeCalls > 1) {
            throw new Error("close failed as error");
          }
          throw "close failed";
        },
      };
    });
    const mod = await import("../rotating-file-stream.js");
    const path = join(dir, "app.log");
    const s = new mod.RotatingFileStream({ path, maxBytes: 100, maxFiles: 3 });
    const t = new mod.RotatingFileStream({ path: join(dir, "other.log"), maxBytes: 100, maxFiles: 3 });
    let writeError: Error | null | undefined;
    let finalError: Error | null | undefined;
    let secondFinalError: Error | null | undefined;

    s._write(Buffer.from("line\n"), "utf8", (err) => {
      writeError = err;
    });
    s._final((err) => {
      finalError = err;
    });
    t._final((err) => {
      secondFinalError = err;
    });

    expect(writeError).toBeInstanceOf(Error);
    expect(writeError?.message).toBe("write failed");
    expect(finalError).toBeInstanceOf(Error);
    expect(finalError?.message).toBe("close failed");
    expect(secondFinalError).toBeInstanceOf(Error);
    expect(secondFinalError?.message).toBe("close failed as error");
  });

  it("surfaces non-ENOENT rename failures during rotation", async () => {
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        renameSync: () => {
          const err = new Error("rename denied");
          Object.assign(err, { code: "EACCES" });
          throw err;
        },
      };
    });
    const mod = await import("../rotating-file-stream.js");
    const path = join(dir, "app.log");
    const s = new mod.RotatingFileStream({ path, maxBytes: 1, maxFiles: 3 });
    let callbackError: Error | null | undefined;

    s._write(Buffer.from("xx"), "utf8", (err) => {
      callbackError = err;
    });

    expect(callbackError).toBeInstanceOf(Error);
    expect(callbackError?.message).toBe("rename denied");
  });

  it("surfaces non-ENOENT unlink failures during rotation", async () => {
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        unlinkSync: () => {
          const err = new Error("unlink denied");
          Object.assign(err, { code: "EACCES" });
          throw err;
        },
      };
    });
    const mod = await import("../rotating-file-stream.js");
    const path = join(dir, "app.log");
    const s = new mod.RotatingFileStream({ path, maxBytes: 1, maxFiles: 3 });
    let callbackError: Error | null | undefined;

    s._write(Buffer.from("xx"), "utf8", (err) => {
      callbackError = err;
    });

    expect(callbackError).toBeInstanceOf(Error);
    expect(callbackError?.message).toBe("unlink denied");
  });
});
