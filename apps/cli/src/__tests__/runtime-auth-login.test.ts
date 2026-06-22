import {
  BROWSER_LOGIN_TIMEOUT_MS,
  type CodexBrowserLoginOptions,
  type CodexDeviceAuthOptions,
  type DeviceAuthOutcome,
} from "@first-tree/client";
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
  outcome?: DeviceAuthOutcome;
  fireDeviceCode?: boolean;
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
    runBrowserLogin: async (_o: CodexBrowserLoginOptions): Promise<DeviceAuthOutcome> =>
      opts.outcome ?? ({ ok: true } as const),
    runDeviceAuth: async (o: CodexDeviceAuthOptions): Promise<DeviceAuthOutcome> => {
      if (opts.fireDeviceCode !== false) {
        o.onDeviceCode({
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "0WYJ-KDUHH",
          expiresInMinutes: 15,
        });
      }
      // Let the fire-and-forget publishPending settle before resolving.
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
    // First: a browser pending (no device code), so the web shows "finish in browser".
    expect(h.calls[0]?.entry.state).toBe("unauthenticated");
    expect(h.calls[0]?.entry.pendingAuth).toEqual({
      method: "browser",
      expiresAt: new Date(NOW + BROWSER_LOGIN_TIMEOUT_MS).toISOString(),
    });
    // Then: the cleared, authenticated entry from the re-probe.
    expect(h.calls[1]?.entry.state).toBe("ok");
    expect(h.calls[1]?.entry.pendingAuth).toBeUndefined();
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
});

describe("runRuntimeAuthLogin — device-code fallback (method override)", () => {
  it("publishes a device-code pending then ok in order on success", async () => {
    const h = harness({ outcome: { ok: true }, probeResult: okEntry() });
    await runRuntimeAuthLogin({ provider: "codex", method: "device-auth", ref: "d1" }, h.deps);

    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]?.entry.pendingAuth).toEqual({
      method: "device-code",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "0WYJ-KDUHH",
      expiresAt: new Date(NOW + 15 * 60_000).toISOString(),
    });
    expect(h.calls[1]?.entry.state).toBe("ok");
    expect(h.calls[1]?.entry.pendingAuth).toBeUndefined();
  });

  it("on failure without a code, only the cleared re-probe entry is published", async () => {
    const h = harness({
      fireDeviceCode: false,
      outcome: { ok: false, reason: "no-prompt", error: "bad config" },
      probeResult: unauthEntry(),
    });
    await runRuntimeAuthLogin({ provider: "codex", method: "device-auth", ref: "d2" }, h.deps);

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.entry.pendingAuth).toBeUndefined();
    expect(h.logs.some((l) => l.includes("no-prompt"))).toBe(true);
  });
});

describe("runRuntimeAuthLogin — claude-code browser OAuth (cc/codex parity)", () => {
  function claudeHarness(opts: { resolveOk?: boolean; outcome?: DeviceAuthOutcome; probeResult?: CapabilityEntry }) {
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
      runClaudeBrowser: async (): Promise<DeviceAuthOutcome> => opts.outcome ?? ({ ok: true } as const),
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
});
