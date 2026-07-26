import { BROWSER_LOGIN_TIMEOUT_MS, type CodexBrowserLoginOptions, type LoginOutcome } from "@first-tree/client";
import type { CapabilityEntry } from "@first-tree/shared";
import { describe, expect, it, vi } from "vitest";
import { runRuntimeAuthLogin } from "../core/runtime-auth-login.js";

const NOW = Date.parse("2026-06-22T12:00:00.000Z");

// Detection is install-only: a re-probed installed provider is always `ok`
// (no auth state). Both helpers build that install entry; `installedEntry` is
// the marker-free re-probe result, and tests override `state`/`available` for
// the binary-vanished (`missing`) case.
const okEntry = (over: Partial<CapabilityEntry> = {}): CapabilityEntry => ({
  state: "ok",
  available: true,
  sdkVersion: "0.130.0",
  detectedAt: "2026-06-22T12:00:01.000Z",
  ...over,
});

const installedEntry = (over: Partial<CapabilityEntry> = {}): CapabilityEntry => okEntry(over);

type Recorded = { provider: string; entry: CapabilityEntry };

function harness(opts: {
  resolveOk?: boolean;
  outcome?: LoginOutcome;
  fireAuthUrl?: string;
  probeResult?: CapabilityEntry;
  current?: CapabilityEntry;
  throwLogin?: unknown;
  probeThrows?: unknown;
}) {
  const calls: Recorded[] = [];
  const logs: string[] = [];
  const deps = {
    currentEntry: (): CapabilityEntry | undefined => opts.current,
    setProviderEntry: async (provider: string, entry: CapabilityEntry): Promise<void> => {
      calls.push({ provider, entry });
    },
    log: (_symbol: string, msg: string): void => {
      logs.push(msg);
    },
    now: (): number => NOW,
    resolveCodexBinary: async () =>
      opts.resolveOk === false
        ? ({ ok: false, error: "codex binary missing" } as const)
        : ({
            ok: true,
            binary: "/bundled/codex",
            runtimeSource: "bundled" as const,
            runtimePath: null,
            version: "0.130.0",
          } as const),
    runBrowserLogin: async (o: CodexBrowserLoginOptions): Promise<LoginOutcome> => {
      if (opts.fireAuthUrl) o.onAuthUrl?.(opts.fireAuthUrl);
      if (opts.throwLogin !== undefined) throw opts.throwLogin;
      await new Promise((r) => setTimeout(r, 0));
      return opts.outcome ?? ({ ok: true } as const);
    },
    probeCodex: async (): Promise<CapabilityEntry> => {
      if (opts.probeThrows !== undefined) throw opts.probeThrows;
      return opts.probeResult ?? installedEntry();
    },
  };
  return { calls, logs, deps };
}

describe("runRuntimeAuthLogin — primary browser OAuth", () => {
  it("publishes a browser pending then the re-probed ok entry", async () => {
    const h = harness({ outcome: { ok: true }, probeResult: okEntry() });
    await runRuntimeAuthLogin({ provider: "codex", ref: "r1" }, h.deps);

    expect(h.calls).toHaveLength(2);
    // First: the install entry (no prior entry → minimal `ok`) with a browser
    // pending marker layered on, so the web shows "finish in browser".
    expect(h.calls[0]?.entry.state).toBe("ok");
    expect(h.calls[0]?.entry.pendingAuth).toEqual({
      method: "browser",
      expiresAt: new Date(NOW + BROWSER_LOGIN_TIMEOUT_MS).toISOString(),
    });
    // Then: the cleared (marker-free) install entry from the re-probe.
    expect(h.calls[1]?.entry.state).toBe("ok");
    expect(h.calls[1]?.entry.pendingAuth).toBeUndefined();
  });

  it("surfaces the browser auth URL into pendingAuth when the login emits it (no-auto-open recovery)", async () => {
    const h = harness({ outcome: { ok: true }, probeResult: okEntry(), fireAuthUrl: "https://auth.openai.com/x" });
    await runRuntimeAuthLogin({ provider: "codex", ref: "u1" }, h.deps);

    const withUrl = h.calls.find((c) => c.entry.pendingAuth?.authUrl);
    expect(withUrl?.entry.pendingAuth).toMatchObject({ method: "browser", authUrl: "https://auth.openai.com/x" });
  });

  it("preserves the prior entry's runtimeSource/version on the pending entry", async () => {
    const h = harness({
      outcome: { ok: true },
      probeResult: okEntry(),
      current: okEntry({ runtimeSource: "bundled" }),
    });
    await runRuntimeAuthLogin({ provider: "codex", ref: "r2" }, h.deps);
    expect(h.calls[0]?.entry.runtimeSource).toBe("bundled");
    expect(h.calls[0]?.entry.sdkVersion).toBe("0.130.0");
  });

  it("on unresolved binary, reflects the real (missing) state and never logs in", async () => {
    const h = harness({ resolveOk: false, probeResult: { ...installedEntry(), state: "missing", available: false } });
    await runRuntimeAuthLogin({ provider: "codex", ref: "r3" }, h.deps);

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.entry.state).toBe("missing");
    expect(h.logs.some((l) => l.includes("binary unavailable"))).toBe(true);
  });

  it("ignores providers that are not yet supported", async () => {
    const h = harness({});
    await runRuntimeAuthLogin({ provider: "claude-code-tui", ref: "r4" }, h.deps);
    expect(h.calls).toHaveLength(0);
    expect(h.logs.some((l) => l.includes("not supported yet"))).toBe(true);
  });

  it("stamps lastAuthError on the re-probed entry when the login fails (so the web shows 'retry')", async () => {
    const h = harness({
      outcome: { ok: false, reason: "exit-nonzero", error: "account not authorized" },
      probeResult: installedEntry(),
    });
    await runRuntimeAuthLogin({ provider: "codex", ref: "f1" }, h.deps);

    const last = h.calls.at(-1)?.entry;
    // The re-probed install entry stays `ok` (install-only detection); the
    // failure stamps `lastAuthError` so the web shows "sign-in failed — retry".
    expect(last?.state).toBe("ok");
    expect(last?.pendingAuth).toBeUndefined();
    expect(last?.lastAuthError).toMatchObject({ reason: "exit-nonzero", message: "account not authorized" });
    expect(last?.lastAuthError?.at).toBe(new Date(NOW).toISOString());
  });

  it("leaves no lastAuthError after a successful login", async () => {
    const h = harness({ outcome: { ok: true }, probeResult: okEntry() });
    await runRuntimeAuthLogin({ provider: "codex", ref: "f2" }, h.deps);
    expect(h.calls.at(-1)?.entry.lastAuthError).toBeUndefined();
  });

  it("stamps lastAuthError even when the re-probe lands `missing` (failure is no longer state-gated)", async () => {
    // Binary vanished mid-flight → re-probe lands `missing`. `attachAuthError`
    // now stamps the failure whenever one is present, independent of state (the
    // old "only when unauthenticated" gate is gone with install-only detection).
    const h = harness({ resolveOk: false, probeResult: { ...installedEntry(), state: "missing", available: false } });
    await runRuntimeAuthLogin({ provider: "codex", ref: "f3" }, h.deps);
    expect(h.calls.at(-1)?.entry.state).toBe("missing");
    expect(h.calls.at(-1)?.entry.lastAuthError).toMatchObject({ reason: "spawn-error" });
  });

  it("logs thrown browser login errors and re-probe failures without throwing", async () => {
    const loginThrows = harness({ throwLogin: "browser crashed", probeResult: installedEntry() });
    await runRuntimeAuthLogin({ provider: "codex", ref: "throw-login" }, loginThrows.deps);
    expect(loginThrows.logs.some((l) => l.includes("codex login threw: browser crashed"))).toBe(true);
    expect(loginThrows.calls.at(-1)?.entry.lastAuthError).toMatchObject({
      reason: "spawn-error",
      message: "browser crashed",
    });

    const probeThrows = harness({ resolveOk: false, probeThrows: "probe crashed" });
    await runRuntimeAuthLogin({ provider: "codex", ref: "throw-probe" }, probeThrows.deps);
    expect(
      probeThrows.logs.some((l) => l.includes("codex re-probe after unresolved binary failed: probe crashed")),
    ).toBe(true);
  });
});

describe("runRuntimeAuthLogin — claude-code browser OAuth (cc/codex parity)", () => {
  function claudeHarness(opts: {
    resolveOk?: boolean;
    outcome?: LoginOutcome;
    fireAuthUrl?: string;
    probeResult?: CapabilityEntry;
    throwLogin?: unknown;
    probeThrows?: unknown;
  }) {
    const calls: Recorded[] = [];
    const logs: string[] = [];
    // Spy so a test can assert the TUI probe is NOT spawned while claude-code-tui
    // is disabled (it shares the Claude keychain, but "stop probing it" must hold
    // on this login-reflection path too).
    const probeClaudeTui = vi.fn(async (): Promise<CapabilityEntry> => opts.probeResult ?? installedEntry());
    const deps = {
      currentEntry: (): CapabilityEntry | undefined => undefined,
      setProviderEntry: async (provider: string, entry: CapabilityEntry): Promise<void> => {
        calls.push({ provider, entry });
      },
      log: (_s: string, msg: string): void => {
        logs.push(msg);
      },
      now: (): number => NOW,
      resolveClaudeLogin: () =>
        opts.resolveOk === false
          ? ({ ok: false, error: "no claude CLI" } as const)
          : ({ ok: true, command: "/usr/local/bin/claude", baseArgs: [] as string[] } as const),
      runClaudeBrowser: async (options: { onAuthUrl?: (url: string) => void }): Promise<LoginOutcome> => {
        if (opts.fireAuthUrl) options.onAuthUrl?.(opts.fireAuthUrl);
        if (opts.throwLogin !== undefined) throw opts.throwLogin;
        return opts.outcome ?? ({ ok: true } as const);
      },
      probeClaude: async (): Promise<CapabilityEntry> => {
        if (opts.probeThrows !== undefined) throw opts.probeThrows;
        return opts.probeResult ?? installedEntry();
      },
      probeClaudeTui,
    };
    return { calls, logs, deps, probeClaudeTui };
  }

  // claude-code-tui is in DISABLED_RUNTIME_PROVIDERS, so a claude-code login
  // reflects claude-code ONLY — the shared-keychain TUI re-probe is suppressed
  // here exactly as it is in the capability aggregator (no `claude` / tmux spawn,
  // no tui entry written). If TUI is ever re-enabled, the both-providers path
  // (Promise.all) takes over again.
  it("browser pending, then re-probes claude-code only while TUI is disabled (no TUI spawn)", async () => {
    const h = claudeHarness({ outcome: { ok: true }, probeResult: okEntry() });
    await runRuntimeAuthLogin({ provider: "claude-code", ref: "c1" }, h.deps);

    // pending(claude-code) → ok(claude-code); no claude-code-tui write.
    expect(h.calls).toHaveLength(2);
    expect(h.calls.map((c) => c.provider)).toEqual(["claude-code", "claude-code"]);
    expect(h.calls[0]?.entry.pendingAuth).toEqual({
      method: "browser",
      expiresAt: new Date(NOW + BROWSER_LOGIN_TIMEOUT_MS).toISOString(),
    });
    expect(h.calls[1]?.entry.state).toBe("ok");
    expect(h.calls[1]?.entry.pendingAuth).toBeUndefined();
    expect(h.calls.some((c) => c.provider === "claude-code-tui")).toBe(false);
    expect(h.probeClaudeTui).not.toHaveBeenCalled();
  });

  it("surfaces the Claude browser auth URL into pendingAuth", async () => {
    const h = claudeHarness({ outcome: { ok: true }, probeResult: okEntry(), fireAuthUrl: "https://claude.ai/login" });
    await runRuntimeAuthLogin({ provider: "claude-code", ref: "c-url" }, h.deps);

    const withUrl = h.calls.find((c) => c.entry.pendingAuth?.authUrl);
    expect(withUrl?.entry.pendingAuth).toMatchObject({ method: "browser", authUrl: "https://claude.ai/login" });
  });

  it("on unresolved CLI, reflects claude-code real state and never logs in (TUI untouched)", async () => {
    const h = claudeHarness({
      resolveOk: false,
      probeResult: { ...installedEntry(), state: "missing", available: false },
    });
    await runRuntimeAuthLogin({ provider: "claude-code", ref: "c2" }, h.deps);

    expect(h.calls.map((c) => c.provider)).toEqual(["claude-code"]);
    expect(h.calls.every((c) => c.entry.state === "missing")).toBe(true);
    expect(h.probeClaudeTui).not.toHaveBeenCalled();
    expect(h.logs.some((l) => l.includes("claude CLI unavailable"))).toBe(true);
  });

  it("on login failure, stamps lastAuthError on claude-code (TUI not re-probed while disabled)", async () => {
    const h = claudeHarness({ outcome: { ok: false, reason: "timeout", error: "claude auth login timed out" } });
    await runRuntimeAuthLogin({ provider: "claude-code", ref: "c3" }, h.deps);

    const cc = h.calls.filter((c) => c.provider === "claude-code").at(-1)?.entry;
    expect(cc?.lastAuthError).toMatchObject({ reason: "timeout", message: "claude auth login timed out" });
    expect(h.calls.some((c) => c.provider === "claude-code-tui")).toBe(false);
    expect(h.probeClaudeTui).not.toHaveBeenCalled();
  });

  it("logs thrown Claude login errors and re-probe failures without throwing", async () => {
    const loginThrows = claudeHarness({ throwLogin: "browser crashed" });
    await runRuntimeAuthLogin({ provider: "claude-code", ref: "c4" }, loginThrows.deps);
    expect(loginThrows.logs.some((l) => l.includes("claude auth login threw: browser crashed"))).toBe(true);
    expect(loginThrows.calls.at(-1)?.entry.lastAuthError).toMatchObject({
      reason: "spawn-error",
      message: "browser crashed",
    });

    const probeThrows = claudeHarness({ resolveOk: false, probeThrows: "probe crashed" });
    await runRuntimeAuthLogin({ provider: "claude-code", ref: "c5" }, probeThrows.deps);
    expect(probeThrows.logs.some((l) => l.includes("claude re-probe after unresolved CLI failed: probe crashed"))).toBe(
      true,
    );
  });
});

describe("runRuntimeAuthLogin — cursor (external-only binary)", () => {
  function cursorHarness(opts: {
    resolveOk?: boolean;
    outcome?: LoginOutcome;
    fireAuthUrl?: string;
    probeResult?: CapabilityEntry;
  }) {
    const calls: Recorded2[] = [];
    const logs: string[] = [];
    const loginCalls: string[] = [];
    const deps = {
      currentEntry: (): CapabilityEntry | undefined => undefined,
      setProviderEntry: async (provider: string, entry: CapabilityEntry): Promise<void> => {
        calls.push({ provider, entry });
      },
      log: (_symbol: string, msg: string): void => {
        logs.push(msg);
      },
      now: (): number => NOW,
      resolveCursorBinary: () =>
        opts.resolveOk === false
          ? ({ ok: false, error: "Cursor Agent CLI is missing on this machine.", transient: false } as const)
          : ({ ok: true, binary: "/home/op/.local/bin/cursor-agent", version: "2026.07.09" } as const),
      runCursorBrowser: async (o: { binary: string; onAuthUrl?: (url: string) => void }): Promise<LoginOutcome> => {
        loginCalls.push(o.binary);
        if (opts.fireAuthUrl) o.onAuthUrl?.(opts.fireAuthUrl);
        await new Promise((r) => setTimeout(r, 0));
        return opts.outcome ?? ({ ok: true } as const);
      },
      probeCursor: async (): Promise<CapabilityEntry> => opts.probeResult ?? installedEntry(),
    };
    return { calls, logs, loginCalls, deps };
  }
  type Recorded2 = { provider: string; entry: CapabilityEntry };

  it("drives <resolved-binary> login and publishes pending → re-probed ok", async () => {
    const h = cursorHarness({ outcome: { ok: true }, probeResult: okEntry() });
    await runRuntimeAuthLogin({ provider: "cursor", ref: "rc1" }, h.deps);

    expect(h.loginCalls).toEqual(["/home/op/.local/bin/cursor-agent"]);
    expect(h.calls[0]?.provider).toBe("cursor");
    expect(h.calls[0]?.entry.pendingAuth).toMatchObject({ method: "browser" });
    expect(h.calls.at(-1)?.entry.state).toBe("ok");
    expect(h.calls.at(-1)?.entry.lastAuthError).toBeUndefined();
  });

  it("on unresolved/unverified binary, reflects a spawn-error lastAuthError and never logs in", async () => {
    const h = cursorHarness({
      resolveOk: false,
      probeResult: { ...installedEntry(), state: "missing", available: false },
    });
    await runRuntimeAuthLogin({ provider: "cursor", ref: "rc2" }, h.deps);

    expect(h.loginCalls).toEqual([]);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.entry.state).toBe("missing");
    expect(h.calls[0]?.entry.lastAuthError).toMatchObject({ reason: "spawn-error" });
    expect(h.logs.some((l) => l.includes("cursor binary unavailable"))).toBe(true);
  });

  it("stamps lastAuthError when the cursor login fails", async () => {
    const h = cursorHarness({
      outcome: { ok: false, reason: "exit-nonzero", error: "login failed" },
      probeResult: installedEntry(),
    });
    await runRuntimeAuthLogin({ provider: "cursor", ref: "rc3" }, h.deps);
    expect(h.calls.at(-1)?.entry.lastAuthError).toMatchObject({ reason: "exit-nonzero", message: "login failed" });
  });
});
