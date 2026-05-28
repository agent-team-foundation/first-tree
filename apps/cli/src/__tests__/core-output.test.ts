import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blank, print, setJsonMode, status } from "../core/output.js";

describe("core output", () => {
  let stdout = "";
  let stderr = "";

  beforeEach(() => {
    stdout = "";
    stderr = "";
    setJsonMode(false);
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
  });

  afterEach(() => {
    setJsonMode(false);
    vi.restoreAllMocks();
  });

  it("writes machine-readable result and failure envelopes", () => {
    print.result({ value: 1 });
    expect(stdout).toBe('{"ok":true,"data":{"value":1}}\n');

    expect(() => print.fail("BAD", "nope", 3)).toThrow("exit:3");
    expect(stderr).toBe('{"ok":false,"error":{"code":"BAD","message":"nope"}}\n');
  });

  it("writes human status/check/blank/line output only outside JSON mode", () => {
    status("server", "ready");
    print.check(true, "database", "ok");
    print.check(false, "daemon");
    blank();
    print.line("details\n");

    expect(stderr).toContain("server");
    expect(stderr).toContain("\u2713 database");
    expect(stderr).toContain("\u2717 daemon");
    expect(stderr).toContain("details");

    stderr = "";
    setJsonMode(true);
    expect(print).toBeDefined();
    expect(print.line("hidden\n")).toBeUndefined();
    print.status("server", "hidden");
    print.check(true, "hidden");
    print.blank();
    expect(stderr).toBe("");
  });
});
