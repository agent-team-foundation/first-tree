import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildProbeScript,
  getLoginShellPathDirs,
  type RunShell,
  resetLoginShellPathDirsCache,
} from "../runtime/login-shell-path.js";

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

/**
 * Integration coverage for the real probe script. The script is launched by the
 * user's login shell as a single opaque `/bin/sh -c '…'` token, so it must run
 * identically no matter what that outer shell is — that shell-agnostic launcher
 * shape is exactly what lets fish / tcsh (which cannot parse a POSIX `do … done`
 * loop) work. We cannot assume fish is installed in CI, so this exercises the
 * mechanism through `/bin/sh` as the outer launcher (and the platform default
 * via the real `defaultRunShell`); fish itself is covered by the runtime-env-qa
 * `DW7_fish_frozen` scenario.
 */
describe("probe script (real execution)", () => {
  afterEach(() => resetLoginShellPathDirsCache());

  it.skipIf(process.platform === "win32")(
    "runs under a POSIX /bin/sh launcher and yields this process's canonical, absolute PATH dirs",
    () => {
      const runViaSh: RunShell = () => {
        const r = spawnSync("/bin/sh", ["-lic", buildProbeScript()], {
          encoding: "utf-8",
          timeout: 4_000,
          stdio: ["ignore", "pipe", "ignore"],
        });
        return typeof r.stdout === "string" ? r.stdout : null;
      };
      const dirs = getLoginShellPathDirs(runViaSh);
      // A real environment always has at least one PATH dir, and every dir the
      // probe returns is canonicalized (`pwd -P`) so it must be absolute.
      expect(dirs.length).toBeGreaterThan(0);
      for (const dir of dirs) expect(dir.startsWith("/")).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")("the real default-shell probe returns absolute dirs without throwing", () => {
    const dirs = getLoginShellPathDirs();
    expect(Array.isArray(dirs)).toBe(true);
    for (const dir of dirs) expect(dir.startsWith("/")).toBe(true);
  });
});
