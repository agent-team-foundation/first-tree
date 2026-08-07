import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findCodexExecutableOnPath } from "../runtime/codex-binary.js";
import { versionManagerBinDirs, wellKnownBinDirs } from "../runtime/install-locations.js";
import { getLoginShellPathDirs, resetLoginShellPathDirsCache } from "../runtime/login-shell-path.js";

const NEVER_LISTED = (path: string): string[] => {
  throw new Error(`unexpected readdir: ${path}`);
};

describe("versionManagerBinDirs", () => {
  // Pin a non-macOS baseline: on macOS these synthetic roots go through
  // protected-root resolution, which follows real symlinks (`/home` is a
  // firmlink there) and would rewrite them. The macOS cases opt in below.
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "linux" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(process, "platform", { value: "linux" });
  });

  it("returns the sole candidate when exactly one root holds exactly one version", () => {
    const home = "/home/u";
    const versions = join(home, ".nvm", "versions", "node");
    expect(versionManagerBinDirs(home, { readDir: (path) => (path === versions ? ["v22.2.0"] : []), env: {} })).toEqual(
      [join(versions, "v22.2.0", "bin")],
    );
  });

  // Which version the shell selected is not recoverable from disk, and
  // answering with the wrong one silently swaps the executable the user pinned.
  // Ambiguity is judged across the WHOLE state, not per root.
  it("contributes nothing from a root holding more than one version", () => {
    const home = "/home/u";
    const versions = join(home, ".local", "share", "fnm", "node-versions");
    expect(
      versionManagerBinDirs(home, {
        readDir: (path) => (path === versions ? ["v20.11.0", "v22.2.0"] : []),
        env: {},
      }),
    ).toEqual([]);
  });

  it("contributes nothing when two roots each hold one version", () => {
    const home = "/home/u";
    const nvm = join(home, ".nvm", "versions", "node");
    const fnm = join(home, ".local", "share", "fnm", "node-versions");
    expect(
      versionManagerBinDirs(home, {
        readDir: (path) => (path === nvm ? ["v22.2.0"] : path === fnm ? ["v18.0.0"] : []),
        env: {},
      }),
    ).toEqual([]);
  });

  it("uses only the active $FNM_DIR the shell reported, and only when it is unambiguous", () => {
    const home = "/home/u";
    const activeVersions = join("/opt/fnm", "node-versions");
    const staleNvm = join(home, ".nvm", "versions", "node");
    const readDir = (path: string): string[] =>
      path === activeVersions ? ["v20.11.0", "v22.2.0"] : path === staleNvm ? ["v18.0.0"] : [];

    // Active root is ambiguous — a stale single-version root elsewhere is NOT a
    // better answer, it is a different installation.
    expect(versionManagerBinDirs(home, { readDir, active: { fnmDir: "/opt/fnm" }, env: {} })).toEqual([]);

    // Same active root, now unambiguous: it answers, and the stale root still
    // plays no part.
    expect(
      versionManagerBinDirs(home, {
        readDir: (path) => (path === activeVersions ? ["v20.11.0"] : path === staleNvm ? ["v18.0.0"] : []),
        active: { fnmDir: "/opt/fnm" },
        env: {},
      }),
    ).toEqual([join(activeVersions, "v20.11.0", "installation", "bin")]);
  });

  it("takes $NVM_BIN as authoritative instead of enumerating nvm", () => {
    const home = "/home/u";
    const active = join(home, ".nvm", "versions", "node", "v20.11.0", "bin");
    expect(
      versionManagerBinDirs(home, {
        // Two installed versions would be ambiguous on their own; the shell
        // named the selected one, so there is nothing to guess.
        readDir: () => ["v20.11.0", "v22.2.0"],
        active: { nvmBin: active },
        env: {},
      }),
    ).toEqual([active]);
  });

  // Both variables set says two managers initialised, not which one `$PATH`
  // had put first — and that ordering is precisely what is gone. Neither form
  // may quietly resolve to nvm just because it is cheaper to answer.
  it("fails closed when the shell reported both managers", () => {
    const home = "/home/u";
    const nvmBin = join(home, ".nvm", "versions", "node", "v20.11.0", "bin");
    const fnmVersions = join("/opt/fnm", "node-versions");

    // …with an unambiguous fnm root.
    expect(
      versionManagerBinDirs(home, {
        readDir: (path) => (path === fnmVersions ? ["v18.0.0"] : []),
        active: { nvmBin, fnmDir: "/opt/fnm" },
        env: {},
      }),
    ).toEqual([]);

    // …and with an ambiguous one, where falling through to nvm would look
    // harmless but is the same guess.
    expect(
      versionManagerBinDirs(home, {
        readDir: (path) => (path === fnmVersions ? ["v18.0.0", "v22.2.0"] : []),
        active: { nvmBin, fnmDir: "/opt/fnm" },
        env: {},
      }),
    ).toEqual([]);
  });

  it("returns nothing when no version manager is installed", () => {
    expect(
      versionManagerBinDirs("/home/u", {
        readDir: () => {
          throw new Error("ENOENT");
        },
        env: {},
      }),
    ).toEqual([]);
  });

  it("keeps version dirs out of wellKnownBinDirs, whose precedence is above the login shell", () => {
    // Well-known dirs are searched BEFORE the login-shell PATH, so a newest-first
    // version list there would outrank the version the shell actually selected.
    // The fallback belongs after the login shell instead.
    const dirs = wellKnownBinDirs("/home/u");
    expect(dirs.some((dir) => dir.includes(".nvm"))).toBe(false);
    expect(dirs.some((dir) => dir.includes("fnm"))).toBe(false);
  });
});

// A version-manager root is not trusted for being spelled like one. `$FNM_DIR`
// is user-controlled, and `~/.nvm`, a fnm data dir, or one version entry can be
// a symlink — or sit under one — pointing into a protected folder. Listing such
// a root, or handing its `bin` dirs to an executable check, is the same TCC
// access this change exists to remove.
describe("versionManagerBinDirs protected-root vetting (macOS)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(process, "platform", { value: "linux" });
  });

  function macHome(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ft-vm-")));
    const home = join(root, "home");
    mkdirSync(join(home, "Documents"), { recursive: true });
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.stubEnv("HOME", home);
    return home;
  }

  it("never lists a $FNM_DIR pointing into a protected folder", () => {
    const home = macHome();
    expect(
      versionManagerBinDirs(home, { readDir: NEVER_LISTED, env: { FNM_DIR: join(home, "Documents", "fnm") } }),
    ).toEqual([]);
  });

  it("never lists a default root symlinked into a protected folder", () => {
    const home = macHome();
    mkdirSync(join(home, "Documents", "nvm", "versions", "node"), { recursive: true });
    symlinkSync(join(home, "Documents", "nvm"), join(home, ".nvm"));

    expect(versionManagerBinDirs(home, { readDir: NEVER_LISTED, env: {} })).toEqual([]);
  });

  it("drops a version entry symlinked into a protected folder", () => {
    const home = macHome();
    const versions = join(home, ".nvm", "versions", "node");
    mkdirSync(versions, { recursive: true });
    mkdirSync(join(home, "Documents", "sneaky", "bin"), { recursive: true });
    symlinkSync(join(home, "Documents", "sneaky"), join(versions, "v23.0.0"));

    // The root itself is fine and holds exactly one version, so only the
    // per-candidate vetting can reject it.
    expect(versionManagerBinDirs(home, { readDir: (path) => (path === versions ? ["v23.0.0"] : []), env: {} })).toEqual(
      [],
    );
  });
});

// Vetting the directory a candidate came from is not enough, and neither is
// trusting the source that produced it. The check has to happen on the complete
// candidate, at the last moment before `stat` / `access` follows it.
describe("executable candidates are vetted, whatever produced them (macOS)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(process, "platform", { value: "linux" });
  });

  function macRoot(): { root: string; home: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ft-cand-")));
    const home = join(root, "home");
    mkdirSync(join(home, "Documents"), { recursive: true });
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.stubEnv("HOME", home);
    return { root, home };
  }

  function executable(path: string): string {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, 0o755);
    return path;
  }

  it("rejects a well-known dir whose ancestor is symlinked into a protected folder", () => {
    const { home } = macRoot();
    // `~/.local` -> `~/Documents/hidden`, so `~/.local/bin/codex` resolves inside
    // Documents even though the spelling of the well-known dir looks ordinary.
    mkdirSync(join(home, "Documents", "hidden", "bin"), { recursive: true });
    executable(join(home, "Documents", "hidden", "bin", "codex"));
    symlinkSync(join(home, "Documents", "hidden"), join(home, ".local"));

    expect(
      findCodexExecutableOnPath(
        { HOME: home, PATH: "" },
        {
          platform: "darwin",
          pathDelimiter: ":",
          loginShellPathDirs: () => [],
          wellKnownDirs: () => [join(home, ".local", "bin")],
          desktopAppDirs: () => [],
        },
      ),
    ).toBeNull();
  });

  it("rejects an executable that is itself a symlink into a protected folder", () => {
    const { home } = macRoot();
    // The directory is entirely ordinary; only the leaf points into Documents.
    const safeBin = join(home, "tools", "bin");
    mkdirSync(safeBin, { recursive: true });
    executable(join(home, "Documents", "codex"));
    symlinkSync(join(home, "Documents", "codex"), join(safeBin, "codex"));

    expect(
      findCodexExecutableOnPath(
        { HOME: home, PATH: "" },
        {
          platform: "darwin",
          pathDelimiter: ":",
          loginShellPathDirs: () => [safeBin],
          wellKnownDirs: () => [],
          desktopAppDirs: () => [],
        },
      ),
    ).toBeNull();
  });

  it("still resolves an ordinary executable, and one symlinked outside protected roots", () => {
    const { root, home } = macRoot();
    const plainBin = join(home, "tools", "bin");
    const linkedBin = join(home, "linked", "bin");
    mkdirSync(plainBin, { recursive: true });
    mkdirSync(linkedBin, { recursive: true });
    const real = executable(join(root, "elsewhere", "codex"));
    symlinkSync(real, join(linkedBin, "codex"));
    executable(join(plainBin, "codex"));

    for (const dir of [plainBin, linkedBin]) {
      expect(
        findCodexExecutableOnPath(
          { HOME: home, PATH: "" },
          {
            platform: "darwin",
            pathDelimiter: ":",
            loginShellPathDirs: () => [dir],
            wellKnownDirs: () => [],
            desktopAppDirs: () => [],
          },
        ),
      ).toBe(join(dir, "codex"));
    }
  });
});

describe("version-manager discovery after a multishell teardown", () => {
  // The exact regression #1314 fixed, re-checked against the mechanism that
  // replaced it. fnm puts a per-session SYMLINK on `$PATH`; it is gone once the
  // probe shell exits, so nothing can follow it afterwards. The binary itself
  // never moved — it lives in the stable version dir — and that is what must
  // keep the provider discoverable.
  it("still finds a codex installed under fnm once the session symlink is gone", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ft-fnm-")));
    const home = join(root, "home");
    const installBin = join(home, ".local", "share", "fnm", "node-versions", "v22.2.0", "installation", "bin");
    const multishell = join(root, "fnm_multishells", "4321_9");
    mkdirSync(installBin, { recursive: true });
    mkdirSync(join(root, "fnm_multishells"), { recursive: true });
    const codex = join(installBin, "codex");
    writeFileSync(codex, "#!/bin/sh\n");
    chmodSync(codex, 0o755);
    symlinkSync(installBin, multishell);

    // The login-shell seam models the probe shell's lifetime: by the time it has
    // answered, its per-session dir no longer exists — so only the stable
    // version dir, appended after it, can still answer.
    const loginShellPathDirs = (): string[] => {
      rmSync(multishell, { force: true });
      return [multishell, ...versionManagerBinDirs(home, { env: {} })];
    };

    expect(
      findCodexExecutableOnPath(
        { HOME: home, PATH: "" },
        {
          platform: "linux",
          pathDelimiter: ":",
          loginShellPathDirs,
          // Only the version dirs, so a real binary on this host's `/usr/local`
          // or Homebrew path cannot answer for the mechanism under test.
          wellKnownDirs: () => [],
          desktopAppDirs: () => [],
        },
      ),
    ).toBe(codex);
  });

  // End to end, through the real `getLoginShellPathDirs` composition: two
  // manager variables reported, the fnm per-session entry already gone, and a
  // runnable binary sitting under `$NVM_BIN`. Withholding nvm only from the
  // appended fallback would prove nothing here — the raw `$PATH` lists it, so
  // the resolver would skip the dead entry and launch nvm. Missing is the
  // correct answer: the live shell had selected fnm.
  it("resolves nothing rather than nvm when both managers were reported (macOS)", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ft-dual-")));
    const home = join(root, "home");
    const nvmBin = join(home, ".nvm", "versions", "node", "v22.2.0", "bin");
    const fnmDir = join(root, "custom-fnm");
    const multishell = join(root, "fnm_multishells", "88_2", "bin");
    mkdirSync(nvmBin, { recursive: true });
    mkdirSync(join(fnmDir, "node-versions", "v20.11.0", "installation", "bin"), { recursive: true });
    mkdirSync(home, { recursive: true });
    const nvmCodex = join(nvmBin, "codex");
    writeFileSync(nvmCodex, "#!/bin/sh\n");
    chmodSync(nvmCodex, 0o755);

    // macOS is the platform that resolves after the shell exits, so this is the
    // only one where the capture can arrive with a dead first entry.
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.stubEnv("HOME", home);
    resetLoginShellPathDirsCache();
    const dirs = getLoginShellPathDirs(
      () =>
        `__FT_SHELL_PATH__${multishell}\n${nvmBin}__FT_SHELL_PATH____FT_SHELL_ENV__${fnmDir}\n${nvmBin}__FT_SHELL_ENV__`,
    );
    resetLoginShellPathDirsCache();

    expect(dirs).not.toContain(nvmBin);
    expect(
      findCodexExecutableOnPath(
        { HOME: home, PATH: "" },
        {
          platform: "darwin",
          pathDelimiter: ":",
          loginShellPathDirs: () => dirs,
          wellKnownDirs: () => [],
          desktopAppDirs: () => [],
        },
      ),
    ).toBeNull();
  });

  // Off macOS the shell canonicalizes while it is still alive, so the returned
  // order already establishes which manager `$PATH` had selected. Dropping both
  // trees there would discard a correctly discovered provider for no reason.
  it("keeps a dual-manager PATH intact where the shell already canonicalized it", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ft-dual-linux-")));
    const home = join(root, "home");
    const fnmDir = join(root, "custom-fnm");
    const fnmTarget = join(fnmDir, "node-versions", "v20.11.0", "installation", "bin");
    const nvmBin = join(home, ".nvm", "versions", "node", "v22.2.0", "bin");
    mkdirSync(fnmTarget, { recursive: true });
    mkdirSync(nvmBin, { recursive: true });
    mkdirSync(home, { recursive: true });
    for (const bin of [fnmTarget, nvmBin]) {
      const codex = join(bin, "codex");
      writeFileSync(codex, "#!/bin/sh\n");
      chmodSync(codex, 0o755);
    }

    Object.defineProperty(process, "platform", { value: "linux" });
    vi.stubEnv("HOME", home);
    resetLoginShellPathDirsCache();
    // What a live `cd`/`pwd -P` yields: the multishell entry already resolved to
    // its stable target, still ahead of nvm.
    const dirs = getLoginShellPathDirs(
      () =>
        `__FT_SHELL_PATH__${fnmTarget}\n${nvmBin}__FT_SHELL_PATH____FT_SHELL_ENV__${fnmDir}\n${nvmBin}__FT_SHELL_ENV__`,
    );
    resetLoginShellPathDirsCache();

    expect(dirs.slice(0, 2)).toEqual([fnmTarget, nvmBin]);
    expect(
      findCodexExecutableOnPath(
        { HOME: home, PATH: "" },
        {
          platform: "linux",
          pathDelimiter: ":",
          loginShellPathDirs: () => dirs,
          wellKnownDirs: () => [],
          desktopAppDirs: () => [],
        },
      ),
    ).toBe(join(fnmTarget, "codex"));
  });

  // The precedence the fallback must not disturb. With two versions installed
  // the shell's selection is unrecoverable from disk, so the fallback fails
  // closed: a live selection still wins, and once it is gone the provider
  // reports missing rather than silently running the version the user did not
  // pick.
  it("keeps the shell's active version, and refuses to guess once it is gone", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ft-active-")));
    const home = join(root, "home");
    const versions = join(home, ".nvm", "versions", "node");
    const activeBin = join(versions, "v20.11.0", "bin");
    const newerBin = join(versions, "v22.2.0", "bin");
    mkdirSync(activeBin, { recursive: true });
    mkdirSync(newerBin, { recursive: true });
    for (const bin of [activeBin, newerBin]) {
      const codex = join(bin, "codex");
      writeFileSync(codex, "#!/bin/sh\n");
      chmodSync(codex, 0o755);
    }

    // Ambiguous root: it contributes nothing rather than answering v22.
    const fallback = versionManagerBinDirs(home, { env: {} });
    expect(fallback).toEqual([]);

    const resolveWith = (dirs: string[]): string | null =>
      findCodexExecutableOnPath(
        { HOME: home, PATH: "" },
        {
          platform: "linux",
          pathDelimiter: ":",
          loginShellPathDirs: () => dirs,
          wellKnownDirs: () => [],
          desktopAppDirs: () => [],
        },
      );

    // Live selection present: it wins, exactly as before this change.
    expect(resolveWith([activeBin, ...fallback])).toBe(join(activeBin, "codex"));
    // Selection gone: missing, not silently v22.
    expect(resolveWith([join(root, "dead-multishell", "bin"), ...fallback])).toBeNull();
  });
});
