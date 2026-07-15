import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blank, print, setJsonMode, status } from "../core/output.js";

const originalExit = process.exit;

beforeEach(() => {
  setJsonMode(false);
});

afterEach(() => {
  setJsonMode(false);
  vi.restoreAllMocks();
  process.exit = originalExit;
});

describe("core output helpers", () => {
  it("writes JSON envelopes and human output with json-mode suppression", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.exit = vi.fn(((code?: number) => {
      throw Object.assign(new Error("process.exit"), { code });
    }) as never);

    print.result({ value: 1 });
    expect(stdout).toHaveBeenCalledWith('{"ok":true,"data":{"value":1}}\n');

    expect(() => print.fail("BAD", "broken", 7)).toThrow("process.exit");
    expect(stderr).toHaveBeenCalledWith('{"ok":false,"error":{"code":"BAD","message":"broken"}}\n');
    expect(process.exit).toHaveBeenCalledWith(7);

    stderr.mockClear();
    expect(() => print.fail("CONTEXT_TREE_UNREADABLE", "cannot read", 6, { status: "unreadable" })).toThrow(
      "process.exit",
    );
    expect(stderr).toHaveBeenCalledWith(
      '{"ok":false,"error":{"code":"CONTEXT_TREE_UNREADABLE","message":"cannot read","status":"unreadable"}}\n',
    );
    expect(process.exit).toHaveBeenLastCalledWith(6);

    status("Label", "ready");
    print.status("State", "ok");
    print.check(true, "Passing", "done");
    print.check(false, "Failing");
    blank();
    print.blank();
    print.line("custom\n");
    expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain("custom\n");

    stderr.mockClear();
    setJsonMode(true);
    status("Hidden", "value");
    print.status("Hidden", "value");
    print.check(true, "Hidden");
    blank();
    print.blank();
    print.line("hidden\n");
    expect(stderr).not.toHaveBeenCalled();
  });
});
