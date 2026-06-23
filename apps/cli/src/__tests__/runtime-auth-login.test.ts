import { BROWSER_LOGIN_TIMEOUT_MS, type CodexBrowserLoginOptions, type LoginOutcome } from "@first-tree/client";
import type { CapabilityEntry } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { runRuntimeAuthLogin } from "../core/runtime-auth-login.js";

const NOW = Date.parse("2026-06-22T12:00:00.000Z");

const okEntry = (over: Partial<CapabilityEntry> = {}): CapabilityEntry => ({
  state: "ok",
  available: true,
  authenticated: true,
  authMethod: "auth_json",
  sdkVersion: "0.130.0",
  detectedAt: "2026-06-22T12:00:01.000Z",
  ...over,
});

const unauthEntry = (over: Partial<CapabilityEntry> = {}): CapabilityEntry => ({
  state: "unauthenticated",
  available: true,
  authenticated: false,
  authMethod: "none",
  sdkVersion: "0.130.0",
  detectedAt: "2026-06-22T12:00:01.000Z",
  ...over,
});

type Recorded = { provider: string; entry: CapabilityEntry };

function harness(opts: {
  resolveOk?: boolean;
  outcome?: LoginOutcome;
  fireAuthUrl?: string;
  probeResult?: CapabilityEntry;
  current?: CapabilityEntry;
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
      await new Promise((r) => setTimeout(r, 0));
      return opts.outcome ?? ({ ok: true } as const);
    },
    probeCodex: async (): Promise<CapabilityEntry> => opts.probeResult ?? unauthEntry(),
  };
  return { calls, logs, deps };
}

describe("runRuntimeAuthLogin — primary browser OAuth", () => {
  it("publishes a browser pending then the re-probed ok entry", async () => {
    const h = harness({ outcome: { ok: true }, probeResult: okEntry() });
    await runRuntimeAuthLogin({ provider: "codex", ref: "r1" }, h.deps);

    expect(h.calls).toHaveLength(2);
    // First: a browser pending, so the web shows "finish in browser".
    expect(h.calls[0]?.entry.state).toBe("unauthenticated");
    expect(h.calls[0]?.entry.pendingAuth).toEqual({
      method: "browser",
      expiresAt: new Date(NOW + BROWSER_LOGIN_TIMEOUT_MS).toISOString(),
    });
    // Then: the cleared, authenticated entry from the re-probe.
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
      current: okEntry({ state: "unauthenticated", authenticated: false, runtimeSource: "bundled" }),
    });
    await runRuntimeAuthLogin({ provider: "codex", ref: "r2" }, h.deps);
    expect(h.calls[0]?.entry.runtimeSource).toBe("bundled");
    expect(h.calls[0]?.entry.sdkVersion).toBe("0.130.0");
  });

  it("on unresolved binary, reflects the real (missing) state and never logs in", async () => {
    const h = harness({ resolveOk: false, probeResult: { ...unauthEntry(), state: "missing", available: false } });
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
      probeResult: unauthEntry(),
    });
    await runRuntimeAuthLogin({ provider: "codex", ref: "f1" }, h.deps);

    const last = h.calls.at(-1)?.entry;
    expect(last?.state).toBe("unauthenticated");
    expect(last?.pendingAuth).toBeUndefined();
    expect(last?.lastAuthError).toMatchObject({ reason: "exit-nonzero", message: "account not authorized" });
    expect(last?.lastAuthError?.at).toBe(new Date(NOW).toISOString());
  });

  it("leaves no lastAuthError after a successful login", async () => {
    const h = harness({ outcome: { ok: true }, probeResult: okEntry() });
    await runRuntimeAuthLogin({ provider: "codex", ref: "f2" }, h.deps);
    expect(h.calls.at(-1)?.entry.lastAuthError).toBeUndefined();
  });

  it("does not stamp lastAuthError when the re-probe is non-unauthenticated (install box covers it)", async () => {
    // Binary vanished mid-flight → re-probe lands `missing`, which already
    // renders an install box; a duplicate error record there would be noise.
    const h = harness({ resolveOk: false, probeResult: { ...unauthEntry(), state: "missing", available: false } });
    await runRuntimeAuthLogin({ provider: "codex", ref: "f3" }, h.deps);
    expect(h.calls.at(-1)?.entry.state).toBe("missing");
    expect(h.calls.at(-1)?.entry.lastAuthError).toBeUndefined();
  });
});

describe("runRuntimeAuthLogin — claude-code browser OAuth (cc/codex parity)", () => {
  function claudeHarness(opts: { resolveOk?: boolean; outcome?: LoginOutcome; probeResult?: CapabilityEntry }) {
    const calls: Recorded[] = [];
    const logs: string[] = [];
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
      runClaudeBrowser: async (): Promise<LoginOutcome> => opts.outcome ?? ({ ok: true } as const),
      probeClaude: async (): Promise<CapabilityEntry> => opts.probeResult ?? unauthEntry(),
      // Claude auth is shared with the TUI runtime — re-probe it too.
      probeClaudeTui: async (): Promise<CapabilityEntry> => opts.probeResult ?? unauthEntry(),
    };
    return { calls, logs, deps };
  }

  it("browser pending, then re-probes BOTH claude-code and claude-code-tui (shared auth)", async () => {
    const h = claudeHarness({ outcome: { ok: true }, probeResult: okEntry() });
    await runRuntimeAuthLogin({ provider: "claude-code", ref: "c1" }, h.deps);

    // pending(claude-code) → ok(claude-code) → ok(claude-code-tui)
    expect(h.calls).toHaveLength(3);
    expect(h.calls[0]?.provider).toBe("claude-code");
    expect(h.calls[0]?.entry.pendingAuth).toEqual({
      method: "browser",
      expiresAt: new Date(NOW + BROWSER_LOGIN_TIMEOUT_MS).toISOString(),
    });
    const reprobed = h.calls.slice(1);
    expect(reprobed.map((c) => c.provider).sort()).toEqual(["claude-code", "claude-code-tui"]);
    for (const c of reprobed) {
      expect(c.entry.state).toBe("ok");
      expect(c.entry.pendingAuth).toBeUndefined();
    }
  });

  it("on unresolved CLI, reflects real state for both and never logs in", async () => {
    const h = claudeHarness({
      resolveOk: false,
      probeResult: { ...unauthEntry(), state: "missing", available: false },
    });
    await runRuntimeAuthLogin({ provider: "claude-code", ref: "c2" }, h.deps);

    expect(h.calls.map((c) => c.provider).sort()).toEqual(["claude-code", "claude-code-tui"]);
    expect(h.calls.every((c) => c.entry.state === "missing")).toBe(true);
    expect(h.logs.some((l) => l.includes("claude CLI unavailable"))).toBe(true);
  });

  it("on login failure, stamps lastAuthError on claude-code only (not the shared-keychain tui)", async () => {
    const h = claudeHarness({ outcome: { ok: false, reason: "timeout", error: "claude auth login timed out" } });
    await runRuntimeAuthLogin({ provider: "claude-code", ref: "c3" }, h.deps);

    const cc = h.calls.filter((c) => c.provider === "claude-code").at(-1)?.entry;
    const tui = h.calls.filter((c) => c.provider === "claude-code-tui").at(-1)?.entry;
    expect(cc?.lastAuthError).toMatchObject({ reason: "timeout", message: "claude auth login timed out" });
    expect(tui?.lastAuthError).toBeUndefined();
  });
});
