import { afterEach, describe, expect, it, vi } from "vitest";
import { getLoginShellPathDirs, resetLoginShellPathDirsCache } from "../runtime/login-shell-path.js";

const DELIM = "__FT_SHELL_PATH__";

function wrap(path: string): string {
  return `some prompt noise\n${DELIM}${path}${DELIM}\n`;
}

describe("getLoginShellPathDirs", () => {
  afterEach(() => {
    resetLoginShellPathDirsCache();
    Object.defineProperty(process, "platform", { value: "linux" });
  });

  it("parses the delimited PATH from shell output, dropping empties", () => {
    const dirs = getLoginShellPathDirs(() => wrap("/home/u/.nvm/v/bin::/usr/local/bin:"));
    expect(dirs).toEqual(["/home/u/.nvm/v/bin", "/usr/local/bin"]);
  });

  it("returns [] when the shell output is null (probe failure)", () => {
    expect(getLoginShellPathDirs(() => null)).toEqual([]);
  });

  it("returns [] when the delimiters are missing (parse miss)", () => {
    expect(getLoginShellPathDirs(() => "no markers here")).toEqual([]);
  });

  it("returns [] on win32 without invoking the shell", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const runShell = vi.fn(() => wrap("/should/not/be/used"));
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(runShell).not.toHaveBeenCalled();
  });

  it("does not throw when the shell seam throws", () => {
    expect(() =>
      getLoginShellPathDirs(() => {
        throw new Error("spawn failed");
      }),
    ).not.toThrow();
    expect(
      getLoginShellPathDirs(() => {
        throw new Error("spawn failed");
      }),
    ).toEqual([]);
  });

  it("memoizes: the shell seam runs at most once across calls", () => {
    const runShell = vi.fn(() => wrap("/a/bin"));
    const first = getLoginShellPathDirs(runShell);
    const second = getLoginShellPathDirs(runShell);
    expect(first).toEqual(["/a/bin"]);
    expect(second).toEqual(["/a/bin"]);
    expect(runShell).toHaveBeenCalledTimes(1);
  });

  it("caches the empty/failed result too (no re-probe after a miss)", () => {
    const runShell = vi.fn(() => null);
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(runShell).toHaveBeenCalledTimes(1);
  });
});
