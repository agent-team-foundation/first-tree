import type { CapabilityEntry } from "@first-tree/shared";
import { runtimeAuthProviderSchema } from "@first-tree/shared";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeAuthDriver } from "../providers/auth-driver.js";
import { RUNTIME_AUTH_DRIVERS } from "../providers/auth-drivers.js";
import { createGrokAuthDriver } from "../providers/grok/login.js";
import type { LoginOutcome } from "../providers/runtime-login.js";
import { createClaudeAuthDriver } from "../runtime/claude-login.js";
import { createCodexAuthDriver } from "../runtime/codex-login.js";
import { createCursorAuthDriver } from "../runtime/cursor-login.js";

const entry = (over: Partial<CapabilityEntry> = {}): CapabilityEntry => ({
  state: "ok",
  available: true,
  detectedAt: "2026-06-22T12:00:00.000Z",
  ...over,
});

describe("RUNTIME_AUTH_DRIVERS composition root", () => {
  it("is frozen and exhaustive over the server-accepted auth provider set", () => {
    expect(Object.isFrozen(RUNTIME_AUTH_DRIVERS)).toBe(true);
    // The narrow runtime-auth enum, not the full runtime-provider enum: Kimi /
    // OpenCode / Pi keep provider-owned host login and claude-code-tui shares
    // Claude Code's credential, so none of them may become a Connect target.
    expect(Object.keys(RUNTIME_AUTH_DRIVERS).sort()).toEqual([...runtimeAuthProviderSchema.options].sort());
  });

  it("freezes every registered driver, not just the table that holds them", () => {
    // Object.freeze on the table alone leaves each driver value mutable, so an
    // importer could still repoint RUNTIME_AUTH_DRIVERS.codex.resolveLogin (or
    // .reprobe) for the rest of the process without ever touching the table
    // itself. Every value the table holds must be independently frozen too.
    for (const provider of runtimeAuthProviderSchema.options) {
      expect(Object.isFrozen(RUNTIME_AUTH_DRIVERS[provider]), provider).toBe(true);
    }
  });

  it("rejects reassignment of a driver's methods, and the reassignment never takes effect", () => {
    for (const provider of runtimeAuthProviderSchema.options) {
      const driver = RUNTIME_AUTH_DRIVERS[provider];
      const originalResolveLogin = driver.resolveLogin;
      const originalReprobe = driver.reprobe;
      const hijack = async () => ({ ok: false as const, error: "hijacked" });
      // Assigning to a frozen property throws under the strict-mode ESM this
      // module runs as; either way, the property must be unchanged afterwards.
      try {
        // @ts-expect-error intentional mutation attempt on a readonly contract member
        driver.resolveLogin = hijack;
      } catch {
        // Expected in strict mode.
      }
      try {
        // @ts-expect-error intentional mutation attempt on a readonly contract member
        driver.reprobe = hijack;
      } catch {
        // Expected in strict mode.
      }
      expect(driver.resolveLogin, provider).toBe(originalResolveLogin);
      expect(driver.reprobe, provider).toBe(originalReprobe);
    }
  });

  it("exposes a complete driver for every auth provider", () => {
    for (const provider of runtimeAuthProviderSchema.options) {
      const driver: RuntimeAuthDriver = RUNTIME_AUTH_DRIVERS[provider];
      expect(driver.logLabel, provider).toBeTruthy();
      expect(driver.loginLabel, provider).toBeTruthy();
      expect(driver.artifactLabel, provider).toBeTruthy();
      expect(typeof driver.resolveLogin, provider).toBe("function");
      expect(typeof driver.reprobe, provider).toBe("function");
    }
  });

  it("registers the production-configured driver for each provider", () => {
    const labels = (driver: RuntimeAuthDriver) => [driver.logLabel, driver.loginLabel, driver.artifactLabel];
    expect(labels(RUNTIME_AUTH_DRIVERS["claude-code"])).toEqual(labels(createClaudeAuthDriver()));
    expect(labels(RUNTIME_AUTH_DRIVERS.codex)).toEqual(labels(createCodexAuthDriver()));
    expect(labels(RUNTIME_AUTH_DRIVERS.cursor)).toEqual(labels(createCursorAuthDriver()));
    expect(labels(RUNTIME_AUTH_DRIVERS.grok)).toEqual(labels(createGrokAuthDriver()));
  });

  it("labels claude as a CLI gap and the external providers as binary gaps", () => {
    // Claude may fall back to the SDK-bundled engine, so the operator-facing
    // remediation differs from the external-only providers.
    expect(RUNTIME_AUTH_DRIVERS["claude-code"].artifactLabel).toBe("CLI");
    expect(RUNTIME_AUTH_DRIVERS["claude-code"].loginLabel).toBe("claude auth login");
    for (const provider of ["codex", "cursor", "grok"] as const) {
      expect(RUNTIME_AUTH_DRIVERS[provider].artifactLabel, provider).toBe("binary");
      expect(RUNTIME_AUTH_DRIVERS[provider].loginLabel, provider).toBe(`${provider} login`);
    }
  });
});

describe("every create*AuthDriver factory freezes its own return value", () => {
  // The guarantee has to hold at construction, independent of composition: a
  // caller that constructs a driver directly (a test, a future composition
  // root) gets the same immutability as one read through RUNTIME_AUTH_DRIVERS.
  it.each([
    ["claude-code", () => createClaudeAuthDriver()],
    ["codex", () => createCodexAuthDriver()],
    ["cursor", () => createCursorAuthDriver()],
    ["grok", () => createGrokAuthDriver()],
  ] as const)("%s", (_provider, build) => {
    expect(Object.isFrozen(build())).toBe(true);
  });
});

describe("every driver keeps a broken artifact lookup away from the login", () => {
  // Resolvers touch PATH and the filesystem, so they can throw as well as
  // report a gap. Neither outcome may reach a spawn; the dispatcher turns the
  // throw into the same "login never started" reflection.
  const boom = () => {
    throw new Error("PATH lookup exploded");
  };

  type FakeLogin = () => Promise<LoginOutcome>;

  it.each([
    ["claude-code", (login: FakeLogin) => createClaudeAuthDriver({ resolveLogin: boom, runBrowserLogin: login })],
    ["codex", (login: FakeLogin) => createCodexAuthDriver({ resolveBinary: boom, runBrowserLogin: login })],
    ["cursor", (login: FakeLogin) => createCursorAuthDriver({ resolveBinary: boom, runBrowserLogin: login })],
    ["grok", (login: FakeLogin) => createGrokAuthDriver({ resolveBinary: boom, runBrowserLogin: login })],
  ] as const)("%s", async (_provider, build) => {
    const login = vi.fn(async (): Promise<LoginOutcome> => ({ ok: true }));
    await expect(build(login).resolveLogin()).rejects.toThrow("PATH lookup exploded");
    expect(login).not.toHaveBeenCalled();
  });
});

describe("codex auth driver", () => {
  it("drives the resolved binary and re-probes only codex", async () => {
    const runBrowserLogin = vi.fn(async (): Promise<LoginOutcome> => ({ ok: true }));
    const driver = createCodexAuthDriver({
      resolveBinary: async () => ({
        ok: true,
        binary: "/bundled/codex",
        runtimeSource: "bundled",
        runtimePath: null,
        version: "0.130.0",
      }),
      runBrowserLogin,
      probe: async () => entry({ sdkVersion: "0.130.0" }),
    });

    const resolution = await driver.resolveLogin();
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    const onAuthUrl = vi.fn();
    await expect(resolution.login({ onAuthUrl })).resolves.toEqual({ ok: true });
    expect(runBrowserLogin).toHaveBeenCalledWith({ binary: "/bundled/codex", onAuthUrl });

    await expect(driver.reprobe()).resolves.toEqual([{ provider: "codex", entry: entry({ sdkVersion: "0.130.0" }) }]);
  });

  it("reports an unresolved binary instead of spawning a login", async () => {
    const runBrowserLogin = vi.fn();
    const driver = createCodexAuthDriver({
      resolveBinary: async () => ({ ok: false, error: "codex binary missing" }),
      runBrowserLogin,
      probe: async () => entry(),
    });

    await expect(driver.resolveLogin()).resolves.toEqual({ ok: false, error: "codex binary missing" });
    expect(runBrowserLogin).not.toHaveBeenCalled();
  });
});

describe("cursor and grok auth drivers", () => {
  it("cursor drives the resolved binary and re-probes only cursor", async () => {
    const runBrowserLogin = vi.fn(async (): Promise<LoginOutcome> => ({ ok: true }));
    const driver = createCursorAuthDriver({
      resolveBinary: () => ({ ok: true, binary: "/home/op/.local/bin/cursor-agent", version: "2026.07.09" }),
      runBrowserLogin,
      probe: async () => entry(),
    });

    const resolution = await driver.resolveLogin();
    if (!resolution.ok) throw new Error("expected cursor to resolve");
    const onAuthUrl = vi.fn();
    await resolution.login({ onAuthUrl });

    expect(runBrowserLogin).toHaveBeenCalledWith({ binary: "/home/op/.local/bin/cursor-agent", onAuthUrl });
    await expect(driver.reprobe()).resolves.toEqual([{ provider: "cursor", entry: entry() }]);
  });

  it("grok drives the resolved binary and re-probes only grok", async () => {
    const runBrowserLogin = vi.fn(async (): Promise<LoginOutcome> => ({ ok: true }));
    const driver = createGrokAuthDriver({
      resolveBinary: () => ({ ok: true, binary: "/home/op/.local/bin/grok", version: "2026.07.09" }),
      runBrowserLogin,
      probe: async () => entry(),
    });

    const resolution = await driver.resolveLogin();
    if (!resolution.ok) throw new Error("expected grok to resolve");
    const onAuthUrl = vi.fn();
    await resolution.login({ onAuthUrl });

    expect(runBrowserLogin).toHaveBeenCalledWith({ binary: "/home/op/.local/bin/grok", onAuthUrl });
    await expect(driver.reprobe()).resolves.toEqual([{ provider: "grok", entry: entry() }]);
  });

  it("reports an unresolved binary for both external providers", async () => {
    const cursor = createCursorAuthDriver({
      resolveBinary: () => ({ ok: false, error: "Cursor Agent CLI is missing on this machine.", transient: false }),
      runBrowserLogin: vi.fn(),
      probe: async () => entry(),
    });
    const grok = createGrokAuthDriver({
      resolveBinary: () => ({ ok: false, error: "Grok Build CLI is missing on this machine.", transient: false }),
      runBrowserLogin: vi.fn(),
      probe: async () => entry(),
    });

    await expect(cursor.resolveLogin()).resolves.toMatchObject({ ok: false });
    await expect(grok.resolveLogin()).resolves.toMatchObject({ ok: false });
  });
});

describe("claude auth driver (shared keychain credential)", () => {
  function claudeDriver(opts: { tuiEnabled: boolean }) {
    const probe = vi.fn(async () => entry({ sdkVersion: "sdk" }));
    const probeTui = vi.fn(async () => entry({ sdkVersion: "tui" }));
    const runBrowserLogin = vi.fn(async (): Promise<LoginOutcome> => ({ ok: true }));
    const driver = createClaudeAuthDriver({
      resolveLogin: () => ({ ok: true, command: "/usr/local/bin/claude", baseArgs: [] }),
      runBrowserLogin,
      probe,
      probeTui,
      isProviderEnabled: (provider) => (provider === "claude-code-tui" ? opts.tuiEnabled : true),
    });
    return { driver, probe, probeTui, runBrowserLogin };
  }

  it("refreshes claude-code only, without spawning the TUI probe, while the TUI is disabled", async () => {
    const h = claudeDriver({ tuiEnabled: false });
    await expect(h.driver.reprobe()).resolves.toEqual([
      { provider: "claude-code", entry: entry({ sdkVersion: "sdk" }) },
    ]);
    expect(h.probeTui).not.toHaveBeenCalled();
  });

  it("refreshes both Claude rows in publish order when the TUI is enabled", async () => {
    const h = claudeDriver({ tuiEnabled: true });
    // One Claude login authenticates both runtimes, so the TUI row must not be
    // left reading as a second, separate login the operator still has to do.
    await expect(h.driver.reprobe()).resolves.toEqual([
      { provider: "claude-code", entry: entry({ sdkVersion: "sdk" }) },
      { provider: "claude-code-tui", entry: entry({ sdkVersion: "tui" }) },
    ]);
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.probeTui).toHaveBeenCalledTimes(1);
  });

  it("passes the resolved invocation through to the browser login", async () => {
    const h = claudeDriver({ tuiEnabled: false });
    const resolution = await h.driver.resolveLogin();
    if (!resolution.ok) throw new Error("expected claude to resolve");
    const onAuthUrl = vi.fn();
    await resolution.login({ onAuthUrl });
    expect(h.runBrowserLogin).toHaveBeenCalledWith({
      command: "/usr/local/bin/claude",
      baseArgs: [],
      onAuthUrl,
    });
  });

  it("reports an unresolved CLI instead of spawning a login", async () => {
    const runBrowserLogin = vi.fn();
    const driver = createClaudeAuthDriver({
      resolveLogin: () => ({ ok: false, error: "no claude CLI" }),
      runBrowserLogin,
      probe: async () => entry(),
      probeTui: async () => entry(),
      isProviderEnabled: () => false,
    });

    await expect(driver.resolveLogin()).resolves.toEqual({ ok: false, error: "no claude CLI" });
    expect(runBrowserLogin).not.toHaveBeenCalled();
  });
});
