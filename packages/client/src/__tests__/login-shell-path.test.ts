import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readlinkSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildProbeScript,
  getLoginShellPathDirs,
  type RunShell,
  resetLoginShellPathDirsCache,
} from "../runtime/login-shell-path.js";

const DELIM = "__FT_SHELL_PATH__";

/** Extract the delimited dir list from raw probe stdout. */
function parseDirs(stdout: string): string[] {
  const start = stdout.indexOf(DELIM);
  const end = stdout.indexOf(DELIM, start + DELIM.length);
  return stdout
    .slice(start + DELIM.length, end)
    .split("\n")
    .filter((line) => line.length > 0);
}

/**
 * Simulate the probe stdout: the canonical dirs the login shell prints (one per
 * line) bracketed by {@link DELIM}, preceded by some rc-file prompt noise.
 */
function wrap(dirs: string[]): string {
  return `some prompt noise\n${DELIM}${dirs.join("\n")}${DELIM}\n`;
}

describe("getLoginShellPathDirs", () => {
  // Pin a non-macOS baseline so the parsing tests never depend on the host: on
  // macOS the result goes through protected-root resolution, which follows real
  // symlinks (`/home` is a firmlink there) and would rewrite synthetic paths.
  // The macOS tests opt in explicitly.
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "linux" });
  });

  afterEach(() => {
    resetLoginShellPathDirsCache();
    vi.unstubAllEnvs();
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

  it("drops macOS TCC-protected dirs from a successful probe", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.stubEnv("HOME", "/Users/tester");
    const dirs = getLoginShellPathDirs(() =>
      wrap([
        "/opt/homebrew/bin",
        "/Users/tester/Documents/bin",
        "/Users/tester/Desktop",
        "/Users/tester/Downloads/tools/bin",
        "/Users/tester/Library/Mobile Documents/com~apple~CloudDocs/bin",
        "/Users/tester/Library/CloudStorage/OneDrive/bin",
        "/Users/tester/.nvm/versions/node/v22.0.0/bin",
        // Not protected: a sibling whose name merely starts with a protected one.
        "/Users/tester/Documents-archive/bin",
      ]),
    );
    expect(dirs).toEqual([
      "/opt/homebrew/bin",
      "/Users/tester/.nvm/versions/node/v22.0.0/bin",
      "/Users/tester/Documents-archive/bin",
    ]);
  });

  // The spelling of a `$PATH` entry says nothing about where it lands: `~/bin`
  // can be a symlink to `~/Documents/bin`, and `~/deep/mid/bin` can reach the
  // same place through a symlinked ANCESTOR. Resolution therefore has to reject
  // these without entering them — `readlink` reads the link itself, `cd` /
  // `realpath` / `existsSync` would already be the protected access.
  it.skipIf(process.platform === "win32")("rejects symlinks into a protected root without entering them", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ft-symlink-")));
    const home = join(root, "home");
    mkdirSync(join(home, "Documents", "real", "bin"), { recursive: true });
    mkdirSync(join(home, "deep"), { recursive: true });
    mkdirSync(join(home, "safe", "bin"), { recursive: true });
    // `~/bin` -> `~/Documents/real`, so `~/bin/bin` is a protected target.
    symlinkSync(join(home, "Documents", "real"), join(home, "bin"));
    // `~/deep/mid` -> `~/Documents`, so the protected root is an ANCESTOR.
    symlinkSync(join(home, "Documents"), join(home, "deep", "mid"));
    // A symlink that stays outside must still resolve, and to its target.
    symlinkSync(join(home, "safe", "bin"), join(home, "safe-link"));

    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.stubEnv("HOME", home);
    const dirs = getLoginShellPathDirs(() =>
      wrap([join(home, "bin", "bin"), join(home, "deep", "mid", "real", "bin"), join(home, "safe-link")]),
    );

    expect(dirs).toEqual([join(home, "safe", "bin")]);
  });

  // The macOS filesystem is case-insensitive by default, so `~/documents/bin`
  // IS `~/Documents/bin`. A case-sensitive guard would wave it through and the
  // walk would go on to read the protected path.
  it("matches protected roots regardless of case", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.stubEnv("HOME", "/Users/tester");
    expect(
      getLoginShellPathDirs(() =>
        wrap([
          "/Users/tester/documents/bin",
          "/Users/tester/DOWNLOADS/bin",
          "/Users/tester/Library/mobile documents/bin",
          "/opt/homebrew/bin",
        ]),
      ),
    ).toEqual(["/opt/homebrew/bin"]);
  });

  // The ordering guarantee — check a component against the protected roots
  // BEFORE touching it — is what makes the whole thing work, so assert it
  // directly on the only syscall resolution is allowed to make.
  it.skipIf(process.platform === "win32")("never passes a protected path to readlink", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ft-touch-")));
    const home = join(root, "home");
    mkdirSync(join(home, "Documents", "real", "bin"), { recursive: true });
    mkdirSync(join(home, "deep"), { recursive: true });
    symlinkSync(join(home, "Documents", "real"), join(home, "bin"));
    symlinkSync(join(home, "Documents"), join(home, "deep", "mid"));

    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.stubEnv("HOME", home);
    const touched: string[] = [];
    const readLink = (path: string): string => {
      touched.push(path);
      return readlinkSync(path);
    };

    getLoginShellPathDirs(
      () =>
        wrap([
          join(home, "Documents", "bin"),
          join(home, "documents", "bin"),
          join(home, "bin", "bin"),
          join(home, "deep", "mid", "real", "bin"),
        ]),
      readLink,
    );

    expect(touched.length).toBeGreaterThan(0);
    expect(touched.filter((path) => path.toLowerCase().startsWith(join(home, "documents")))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("does not loop forever on a symlink cycle", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ft-cycle-")));
    symlinkSync(join(root, "b"), join(root, "a"));
    symlinkSync(join(root, "a"), join(root, "b"));

    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.stubEnv("HOME", root);
    expect(getLoginShellPathDirs(() => wrap([join(root, "a")]))).toEqual([]);
  });

  // The teardown case as it actually happens on macOS: the shell emits the raw
  // multishell path, the link is gone by the time resolution runs, and the
  // custom `$FNM_DIR` that produced it exists ONLY in the login shell — the
  // daemon's own environment never saw `fnm env` run. Both the active selection
  // and the custom root have to survive the shell for the provider to be found.
  it.skipIf(process.platform === "win32")("recovers a shell-only FNM_DIR after the multishell link is gone", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ft-shellenv-")));
    const home = join(root, "home");
    const fnmDir = join(root, "custom-fnm");
    const onlyBin = join(fnmDir, "node-versions", "v20.11.0", "installation", "bin");
    const multishell = join(root, "fnm_multishells", "77_1", "bin");
    mkdirSync(onlyBin, { recursive: true });
    mkdirSync(home, { recursive: true });

    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.stubEnv("HOME", home);
    // The daemon environment has no FNM_DIR at all — only the shell reports it.
    vi.stubEnv("FNM_DIR", "");

    const dirs = getLoginShellPathDirs(
      () => `${DELIM}${multishell}${DELIM}${"__FT_SHELL_ENV__"}${fnmDir}\n${"__FT_SHELL_ENV__"}`,
    );

    // The dead per-session entry is kept lexically (it simply fails later
    // existence checks), and the custom root — visible only because the shell
    // reported it — follows.
    expect(dirs).toContain(onlyBin);
  });

  it("keeps protected-looking dirs on non-macOS hosts", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.stubEnv("HOME", "/home/tester");
    expect(getLoginShellPathDirs(() => wrap(["/home/tester/Documents/bin", "/usr/local/bin"]))).toEqual([
      "/home/tester/Documents/bin",
      "/usr/local/bin",
    ]);
  });
});

/**
 * Integration coverage for the real probe script. The login shell launches it as
 * a single opaque `/bin/sh -c '…'` token, so it must run identically no matter
 * what that outer shell is — that shell-agnostic launcher shape is exactly what
 * lets fish / tcsh (which cannot parse a POSIX `do … done` loop) work. We cannot
 * assume fish is installed in CI, so this exercises the mechanism through
 * `/bin/sh` as the outer launcher (and the platform default via the real
 * `defaultRunShell`); fish itself is covered by the runtime-env-qa
 * `DW7_fish_frozen` scenario.
 *
 * The outer launcher is invoked with `-c` only — NOT the production `-lic`. The
 * `-l`/`-i` flags exist solely to source the user's rc files, which this test
 * does not need, and they are not portable: on Ubuntu CI `/bin/sh` is `dash`,
 * whose `-l` support varies. `-c` is universally supported, and the nested
 * `for`/`cd`/`pwd -P` loop runs identically under dash, so this stays green on
 * every POSIX `/bin/sh`.
 */
describe("probe script (real execution)", () => {
  afterEach(() => resetLoginShellPathDirsCache());

  it.skipIf(process.platform === "win32")(
    "runs the opaque nested /bin/sh command under a POSIX shell and yields canonical, absolute PATH dirs",
    () => {
      const r = spawnSync("/bin/sh", ["-c", buildProbeScript()], {
        encoding: "utf-8",
        timeout: 4_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      // Surface a launcher failure explicitly instead of as an opaque empty result.
      expect(r.error).toBeUndefined();
      expect(r.status).toBe(0);
      const dirs = getLoginShellPathDirs(() => (typeof r.stdout === "string" ? r.stdout : null));
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

  // End-to-end over the real shell AND the real parse. A `$PATH` entry can reach
  // a protected root four ways — by spelling, as a symlink, through a symlinked
  // ANCESTOR, and while wearing a spelling an earlier revision trusted (the fnm
  // multishell name) — and none of them may be entered or returned.
  it.skipIf(process.platform === "win32")("never yields a protected dir, however the entry reaches one", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ft-probe-")));
    const home = join(root, "home");
    const safeTarget = join(root, "fnm-install", "bin");
    // A link carrying the fnm multishell NAME but pointing at Documents — the
    // spelling that an earlier revision treated as inherently safe.
    const multishellIntoProtected = join(root, "fnm_multishells", "9999_000", "bin");
    const multishellSafe = join(root, "fnm_multishells", "1234_567", "bin");
    mkdirSync(join(home, "Documents", "real", "bin"), { recursive: true });
    mkdirSync(join(home, "deep"), { recursive: true });
    mkdirSync(join(root, "tools", "bin"), { recursive: true });
    mkdirSync(safeTarget, { recursive: true });
    mkdirSync(join(root, "fnm_multishells", "1234_567"), { recursive: true });
    mkdirSync(join(root, "fnm_multishells", "9999_000"), { recursive: true });
    // Lexically innocent, resolves into Documents: as the entry, and via ancestor.
    symlinkSync(join(home, "Documents", "real"), join(home, "bin"));
    symlinkSync(join(home, "Documents"), join(home, "deep", "mid"));
    symlinkSync(join(home, "Documents", "real", "bin"), multishellIntoProtected);
    symlinkSync(safeTarget, multishellSafe);

    const mustNotLeak = [
      join(home, "Documents", "bin"),
      join(home, "bin", "bin"),
      join(home, "deep", "mid", "real", "bin"),
      multishellIntoProtected,
    ];
    const r = spawnSync("/bin/sh", ["-c", buildProbeScript("darwin")], {
      encoding: "utf-8",
      timeout: 4_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: home,
        PATH: [...mustNotLeak, join(root, "tools", "bin"), multishellSafe].join(":"),
      },
    });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);

    // The shell resolved nothing. Byte-identical echo is the proof: four of
    // these entries are symlinks whose resolved spelling differs from what was
    // written, so any `cd` — and therefore any traversal into the protected
    // target — would show up as a changed line here.
    const raw = parseDirs(typeof r.stdout === "string" ? r.stdout : "");
    expect(raw).toEqual([...mustNotLeak, join(root, "tools", "bin"), multishellSafe]);

    // The parse then drops every route into a protected root and resolves the rest.
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.stubEnv("HOME", home);
    const dirs = getLoginShellPathDirs(() => (typeof r.stdout === "string" ? r.stdout : null));
    expect(dirs).toEqual([join(root, "tools", "bin"), safeTarget]);
  });

  // Unquoted `$PATH` also undergoes PATHNAME expansion, so a wildcard entry
  // makes the shell enumerate that directory — a protected-folder read, and one
  // that leaks its entry names into the result — with no `cd` in sight. Both
  // platforms split the same way, so both are covered.
  it.skipIf(process.platform === "win32").each(["darwin", "linux"] as const)(
    "echoes a wildcard PATH entry literally instead of expanding it (%s)",
    (platform) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "ft-glob-")));
      mkdirSync(join(root, "Documents", "secret-a"), { recursive: true });
      mkdirSync(join(root, "Documents", "secret-b"), { recursive: true });
      const wildcard = join(root, "Documents", "*");

      const r = spawnSync("/bin/sh", ["-c", buildProbeScript(platform)], {
        encoding: "utf-8",
        timeout: 4_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: wildcard },
      });
      expect(r.error).toBeUndefined();

      const raw = parseDirs(typeof r.stdout === "string" ? r.stdout : "");
      expect(raw).not.toContain(join(root, "Documents", "secret-a"));
      expect(raw).not.toContain(join(root, "Documents", "secret-b"));
      // On darwin the literal entry is echoed; on linux `cd` fails on it and
      // drops it. Either way the directory is never enumerated.
      expect(raw).toEqual(platform === "darwin" ? [wildcard] : []);
    },
  );

  it("emits a script with no filesystem access on macOS", () => {
    const darwin = buildProbeScript("darwin");
    expect(darwin).not.toContain("cd ");
    expect(darwin).not.toContain("pwd");
    expect(darwin).not.toContain("readlink");
  });

  it("keeps the shell canonicalization on non-macOS platforms", () => {
    const linux = buildProbeScript("linux");
    expect(linux).toContain('(cd "$d" 2>/dev/null && pwd -P)');
    expect(buildProbeScript("win32")).toBe(linux);
  });
});
