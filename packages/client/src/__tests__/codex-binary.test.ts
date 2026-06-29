import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexBinaryVerifyTransientError,
  createCodexClientWithBinaryFallback,
  findCodexExecutableOnPath,
  formatCodexBinaryMissingMessage,
  isCodexBinaryMissingError,
  verifyCodexExecutable,
} from "../runtime/codex-binary.js";

describe("codex binary resolution", () => {
  let tmp: string | null = null;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it("recognises SDK and CLI wrapper binary-missing errors", () => {
    expect(isCodexBinaryMissingError("Unable to locate Codex CLI binaries for x86_64-apple-darwin")).toBe(true);
    expect(
      isCodexBinaryMissingError(
        "Missing optional dependency @openai/codex-darwin-x64. Reinstall Codex: npm install -g @openai/codex@latest",
      ),
    ).toBe(true);
    const stackOnly = new Error("codex startup failed");
    stackOnly.stack = "Error: codex startup failed\n    at findCodexPath (index.js:445:11)";
    expect(isCodexBinaryMissingError(stackOnly)).toBe(true);
    expect(isCodexBinaryMissingError("Your access token expired")).toBe(false);
  });

  it("falls back to a PATH codex executable when bundled resolution fails", () => {
    const calls: unknown[] = [];
    const log = vi.fn();
    const verifyPath = vi.fn(() => ({ ok: true as const, output: "codex 0.139.0" }));
    const result = createCodexClientWithBinaryFallback(
      { env: { PATH: "/usr/local/bin" } },
      (options) => {
        calls.push(options);
        if (!("codexPathOverride" in options)) {
          throw new Error("Unable to locate Codex CLI binaries for x86_64-apple-darwin");
        }
        return { ok: true, options };
      },
      {
        resolvePath: () => "/usr/local/bin/codex",
        verifyPath,
        log,
      },
    );

    expect(result).toMatchObject({
      client: { ok: true },
      runtimeSource: "path",
      codexPathOverride: "/usr/local/bin/codex",
    });
    expect(calls).toHaveLength(2);
    expect(verifyPath).toHaveBeenCalledWith("/usr/local/bin/codex", { PATH: "/usr/local/bin" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("falling back to system codex"));
  });

  it("does not fall back to a PATH codex executable that cannot start", () => {
    expect(() =>
      createCodexClientWithBinaryFallback(
        { env: { PATH: "/usr/local/bin" } },
        () => {
          throw new Error("Unable to locate Codex CLI binaries for x86_64-apple-darwin");
        },
        {
          resolvePath: () => "/usr/local/bin/codex",
          verifyPath: () => ({ ok: false, transient: false, reason: "`codex --version` exited 1: broken shim" }),
        },
      ),
    ).toThrow(/PATH codex failed validation: `codex --version` exited 1: broken shim/);
  });

  it("treats a transient PATH-codex verify flake as retryable, NOT a missing binary", () => {
    let thrown: unknown;
    try {
      createCodexClientWithBinaryFallback(
        { env: { PATH: "/usr/local/bin" } },
        () => {
          throw new Error("Unable to locate Codex CLI binaries for x86_64-apple-darwin");
        },
        {
          resolvePath: () => "/usr/local/bin/codex",
          verifyPath: () => ({ ok: false, transient: true, reason: "`codex --version` timed out" }),
        },
      );
    } catch (err) {
      thrown = err;
    }
    // A present-but-flaky binary must surface as the transient error the
    // taxonomy retries — never as a permanent "binary missing".
    expect(thrown).toBeInstanceOf(CodexBinaryVerifyTransientError);
    expect((thrown as Error).message).not.toMatch(/binary is missing/i);
    expect(isCodexBinaryMissingError(thrown)).toBe(false);
  });

  it("throws an actionable error when neither bundled nor PATH codex exists", () => {
    expect(() =>
      createCodexClientWithBinaryFallback(
        {},
        () => {
          throw new Error(
            "Unable to locate Codex CLI binaries. Ensure @openai/codex is installed with optional dependencies.",
          );
        },
        { resolvePath: () => null },
      ),
    ).toThrow(/npm install -g @openai\/codex/);
  });

  it("does not swallow non-binary constructor errors", () => {
    expect(() =>
      createCodexClientWithBinaryFallback(
        {},
        () => {
          throw new Error("config exploded");
        },
        { resolvePath: () => "/usr/local/bin/codex" },
      ),
    ).toThrow("config exploded");
  });

  it("finds an executable codex on PATH", () => {
    tmp = mkdtempSync(join(tmpdir(), "ft-codex-path-"));
    const executable = join(tmp, "codex");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);

    expect(findCodexExecutableOnPath({ PATH: `${tmp}${delimiter}/bin` }, { loginShellPathDirs: () => [] })).toBe(
      executable,
    );
  });

  it("verifyCodexExecutable: a deterministic crash signal is NOT transient (broken binary surfaces, no infinite retry)", () => {
    tmp = mkdtempSync(join(tmpdir(), "ft-codex-crash-"));
    const executable = join(tmp, "codex");
    // Self-terminate with SIGSEGV: a binary that always faults on `--version`.
    writeFileSync(executable, "#!/bin/sh\nkill -SEGV $$\n");
    chmodSync(executable, 0o755);

    const v = verifyCodexExecutable(executable, { PATH: "" });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.transient).toBe(false);
      expect(v.reason).toMatch(/SEGV/);
    }
  });

  it("verifyCodexExecutable: a termination kill (timeout-equivalent) IS transient", () => {
    tmp = mkdtempSync(join(tmpdir(), "ft-codex-term-"));
    const executable = join(tmp, "codex");
    // SIGTERM is how a spawnSync timeout enforces its deadline — a host
    // condition, not a broken binary.
    writeFileSync(executable, "#!/bin/sh\nkill -TERM $$\n");
    chmodSync(executable, 0o755);

    const v = verifyCodexExecutable(executable, { PATH: "" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.transient).toBe(true);
  });

  it("finds an executable codex via a login-shell-only PATH dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "ft-codex-login-"));
    tmp = dir;
    const executable = join(dir, "codex");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);

    const found = findCodexExecutableOnPath(
      { PATH: "", HOME: mkdtempSync(join(tmpdir(), "ft-codex-home-")) },
      // wellKnownDirs:[] isolates from a real host codex (e.g. /opt/homebrew/bin)
      // which is now searched before the login-shell PATH.
      { loginShellPathDirs: () => [dir], wellKnownDirs: () => [] },
    );
    expect(found).toBe(executable);
  });

  it("finds an executable codex via a Part-A well-known dir (~/.bun/bin)", () => {
    const home = mkdtempSync(join(tmpdir(), "ft-codex-bun-"));
    tmp = home;
    const bunBin = join(home, ".bun", "bin");
    mkdirSync(bunBin, { recursive: true });
    const executable = join(bunBin, "codex");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);

    expect(findCodexExecutableOnPath({ PATH: "", HOME: home }, { loginShellPathDirs: () => [] })).toBe(executable);
  });

  it("does not throw when the login-shell probe yields nothing (graceful fallback)", () => {
    const home = mkdtempSync(join(tmpdir(), "ft-codex-none-"));
    tmp = home;
    // Empty PATH + login-shell []; resolution then falls through to the curated
    // well-known dirs without throwing (the dev machine may or may not have a
    // codex in an absolute well-known dir, so only assert no-throw here).
    expect(() => findCodexExecutableOnPath({ PATH: "", HOME: home }, { loginShellPathDirs: () => [] })).not.toThrow();
  });

  it("does not consult the login-shell probe when the daemon PATH already resolves codex", () => {
    tmp = mkdtempSync(join(tmpdir(), "ft-codex-daemon-"));
    const executable = join(tmp, "codex");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    const loginShellPathDirs = vi.fn(() => []);

    expect(findCodexExecutableOnPath({ PATH: tmp }, { loginShellPathDirs })).toBe(executable);
    expect(loginShellPathDirs).not.toHaveBeenCalled();
  });

  it("verifies a candidate codex executable by launching --version", () => {
    tmp = mkdtempSync(join(tmpdir(), "ft-codex-version-"));
    const executable = join(tmp, "codex");
    writeFileSync(executable, "#!/bin/sh\necho codex 0.139.0\n");
    chmodSync(executable, 0o755);

    expect(verifyCodexExecutable(executable)).toEqual({ ok: true, output: "codex 0.139.0" });
  });

  it("formats binary-missing messages with the original cause", () => {
    const message = formatCodexBinaryMissingMessage("Unable to locate Codex CLI binaries");
    expect(message).toContain("Codex runtime binary is missing");
    expect(message).toContain("Original error: Unable to locate Codex CLI binaries");
  });
});
