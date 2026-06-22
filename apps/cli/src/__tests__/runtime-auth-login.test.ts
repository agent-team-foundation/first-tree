import type { CodexDeviceAuthOptions, DeviceAuthOutcome } from "@first-tree/client";
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

describe("runRuntimeAuthLogin (codex device-auth)", () => {
  it("publishes pending then ok in order on success", async () => {
    const h = harness({ outcome: { ok: true }, probeResult: okEntry() });
    await runRuntimeAuthLogin({ provider: "codex", ref: "r1" }, h.deps);

    expect(h.calls).toHaveLength(2);
    // First: the device-code pending entry.
    expect(h.calls[0]?.provider).toBe("codex");
    expect(h.calls[0]?.entry.state).toBe("unauthenticated");
    expect(h.calls[0]?.entry.pendingDeviceAuth).toEqual({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "0WYJ-KDUHH",
      expiresAt: new Date(NOW + 15 * 60_000).toISOString(),
    });
    // Then: the cleared, authenticated entry from the re-probe.
    expect(h.calls[1]?.entry.state).toBe("ok");
    expect(h.calls[1]?.entry.pendingDeviceAuth).toBeUndefined();
  });

  it("on failure without a code, only the cleared re-probe entry is published", async () => {
    const h = harness({
      fireDeviceCode: false,
      outcome: { ok: false, reason: "no-prompt", error: "bad config" },
      probeResult: unauthEntry(),
    });
    await runRuntimeAuthLogin({ provider: "codex", ref: "r2" }, h.deps);

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.entry.state).toBe("unauthenticated");
    expect(h.calls[0]?.entry.pendingDeviceAuth).toBeUndefined();
    expect(h.logs.some((l) => l.includes("no-prompt"))).toBe(true);
  });

  it("on unresolved binary, reflects the real (missing) state and never runs device-auth", async () => {
    const h = harness({ resolveOk: false, probeResult: { ...unauthEntry(), state: "missing", available: false } });
    await runRuntimeAuthLogin({ provider: "codex", ref: "r3" }, h.deps);

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.entry.state).toBe("missing");
    expect(h.logs.some((l) => l.includes("binary unavailable"))).toBe(true);
  });

  it("preserves the prior entry's runtimeSource/version on the pending entry", async () => {
    const h = harness({
      outcome: { ok: true },
      probeResult: okEntry(),
      current: okEntry({ state: "unauthenticated", authenticated: false, runtimeSource: "bundled" }),
    });
    await runRuntimeAuthLogin({ provider: "codex", ref: "r4" }, h.deps);
    expect(h.calls[0]?.entry.runtimeSource).toBe("bundled");
    expect(h.calls[0]?.entry.sdkVersion).toBe("0.130.0");
  });

  it("ignores providers that are not yet supported", async () => {
    const h = harness({});
    await runRuntimeAuthLogin({ provider: "claude-code-tui", ref: "r5" }, h.deps);
    expect(h.calls).toHaveLength(0);
    expect(h.logs.some((l) => l.includes("not supported yet"))).toBe(true);
  });
});
