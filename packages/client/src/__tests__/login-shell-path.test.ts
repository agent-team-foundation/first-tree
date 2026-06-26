import { afterEach, describe, expect, it, vi } from "vitest";
import { getLoginShellPathDirs, type RunShell, resetLoginShellPathDirsCache } from "../runtime/login-shell-path.js";

const DELIM = "__FT_SHELL_PATH__";

/**
 * Simulate the probe stdout: the canonical dirs the login shell prints (one per
 * line) bracketed by {@link DELIM}, preceded by some rc-file prompt noise.
 */
function wrap(dirs: string[]): string {
  return `some prompt noise\n${DELIM}${dirs.join("\n")}${DELIM}\n`;
}

describe("getLoginShellPathDirs", () => {
  afterEach(() => {
    resetLoginShellPathDirsCache();
    Object.defineProperty(process, "platform", { value: "linux" });
  });

  it("parses the delimited canonical dirs from shell output, dropping empty lines", () => {
    const dirs = getLoginShellPathDirs(() => wrap(["/home/u/.nvm/v/bin", "", "/usr/local/bin", ""]));
    expect(dirs).toEqual(["/home/u/.nvm/v/bin", "/usr/local/bin"]);
  });

  it("returns [] when the shell output is null (probe failure)", () => {
    expect(getLoginShellPathDirs(() => null)).toEqual([]);
  });

  it("returns [] when the delimiters are missing (parse miss)", () => {
    expect(getLoginShellPathDirs(() => "no markers here")).toEqual([]);
  });

  it("treats a successfully-parsed empty PATH as success (cached, no retry)", () => {
    const runShell = vi.fn(() => wrap([]));
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(runShell).toHaveBeenCalledTimes(1);
  });

  it("returns [] on win32 without invoking the shell", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const runShell = vi.fn(() => wrap(["/should/not/be/used"]));
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

  it("memoizes a successful probe: the shell seam runs once across calls", () => {
    const runShell = vi.fn(() => wrap(["/a/bin"]));
    const first = getLoginShellPathDirs(runShell);
    const second = getLoginShellPathDirs(runShell);
    const third = getLoginShellPathDirs(runShell);
    expect(first).toEqual(["/a/bin"]);
    expect(second).toEqual(["/a/bin"]);
    expect(third).toEqual(["/a/bin"]);
    expect(runShell).toHaveBeenCalledTimes(1);
  });

  it("re-probes a failing shell (null) up to the cap, then settles to [] cached", () => {
    const runShell = vi.fn(() => null);
    // First two calls fail and re-probe; the third hits MAX_ATTEMPTS and caches [].
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(runShell).toHaveBeenCalledTimes(3);
    // Subsequent calls are served from cache — no further spawns past the cap.
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(runShell).toHaveBeenCalledTimes(3);
  });

  it("re-probes a throwing shell up to the cap, then settles to [] cached", () => {
    const runShell = vi.fn(() => {
      throw new Error("spawn failed");
    });
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(runShell).toHaveBeenCalledTimes(3);
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(runShell).toHaveBeenCalledTimes(3);
  });

  it("recovers: a success after transient failures caches and stops retrying", () => {
    const runShell = vi
      .fn<RunShell>()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(wrap(["/late/bin"]))
      .mockReturnValue(wrap(["/unused/bin"]));
    // First call fails (re-probable), second succeeds and caches.
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(getLoginShellPathDirs(runShell)).toEqual(["/late/bin"]);
    expect(getLoginShellPathDirs(runShell)).toEqual(["/late/bin"]);
    expect(runShell).toHaveBeenCalledTimes(2);
  });

  it("does not spawn on win32 even on repeated calls", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const runShell = vi.fn(() => wrap(["/should/not/be/used"]));
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(getLoginShellPathDirs(runShell)).toEqual([]);
    expect(runShell).not.toHaveBeenCalled();
  });
});
