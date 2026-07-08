import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapabilityEntry } from "@first-tree/shared";

describe("runRuntimeAuthLogin default dependencies", () => {
  afterEach(() => {
    vi.doUnmock("@first-tree/client");
    vi.doUnmock("@first-tree/shared");
    vi.resetModules();
  });

  it("uses the default Codex resolver, browser login, and probe", async () => {
    const resolveCodexRuntimeBinary = vi.fn(async () => ({
      ok: true as const,
      binary: "/opt/codex",
      runtimeSource: "bundled" as const,
      runtimePath: null,
      version: "1.0.0",
    }));
    const runCodexBrowserLogin = vi.fn(async (options: { onAuthUrl?: (url: string) => void }) => {
      options.onAuthUrl?.("https://auth.example/codex");
      return { ok: false as const, reason: "timeout" as const, error: "" };
    });
    const probeCodexCapability = vi.fn(async () => ({
      state: "ok" as const,
      available: true,
      detectedAt: "2026-06-22T12:00:00.000Z",
    }));
    vi.doMock("@first-tree/client", () => ({
      BROWSER_LOGIN_TIMEOUT_MS: 120_000,
      probeClaudeCodeCapability: vi.fn(),
      probeClaudeCodeTuiCapability: vi.fn(),
      probeCodexCapability,
      resolveClaudeLoginInvocation: vi.fn(),
      resolveCodexRuntimeBinary,
      runClaudeBrowserLogin: vi.fn(),
      runCodexBrowserLogin,
    }));
    vi.doMock("@first-tree/shared", () => ({
      isRuntimeProviderEnabled: vi.fn(() => false),
    }));
    const { runRuntimeAuthLogin } = await import("../core/runtime-auth-login.js");
    const calls: Array<{ provider: string; entry: CapabilityEntry }> = [];

    await runRuntimeAuthLogin(
      { provider: "codex", ref: "default-codex" },
      {
        currentEntry: () => undefined,
        setProviderEntry: async (provider, entry) => {
          calls.push({ provider, entry });
        },
        log: vi.fn(),
      },
    );

    expect(resolveCodexRuntimeBinary).toHaveBeenCalled();
    expect(runCodexBrowserLogin).toHaveBeenCalledWith({ binary: "/opt/codex", onAuthUrl: expect.any(Function) });
    expect(probeCodexCapability).toHaveBeenCalled();
    expect(calls.map((call) => call.provider)).toEqual(["codex", "codex", "codex"]);
    expect(calls[1]?.entry.pendingAuth?.authUrl).toBe("https://auth.example/codex");
    expect(calls.at(-1)?.entry.lastAuthError).toEqual({
      reason: "timeout",
      at: expect.any(String),
    });
  });

  it("logs Error objects from the default Codex browser login", async () => {
    vi.doMock("@first-tree/client", () => ({
      BROWSER_LOGIN_TIMEOUT_MS: 120_000,
      probeClaudeCodeCapability: vi.fn(),
      probeClaudeCodeTuiCapability: vi.fn(),
      probeCodexCapability: vi.fn(async () => ({
        state: "ok",
        available: true,
        detectedAt: "2026-06-22T12:00:00.000Z",
      })),
      resolveClaudeLoginInvocation: vi.fn(),
      resolveCodexRuntimeBinary: vi.fn(async () => ({
        ok: true,
        binary: "/opt/codex",
        runtimeSource: "bundled",
        runtimePath: null,
        version: "1.0.0",
      })),
      runClaudeBrowserLogin: vi.fn(),
      runCodexBrowserLogin: vi.fn(async () => {
        throw new Error("browser boom");
      }),
    }));
    vi.doMock("@first-tree/shared", () => ({
      isRuntimeProviderEnabled: vi.fn(() => false),
    }));
    const { runRuntimeAuthLogin } = await import("../core/runtime-auth-login.js");
    const logs: string[] = [];

    await runRuntimeAuthLogin(
      { provider: "codex", ref: "default-codex-error" },
      {
        currentEntry: () => undefined,
        setProviderEntry: async () => undefined,
        log: (_symbol, message) => {
          logs.push(message);
        },
      },
    );

    expect(logs).toContain("runtime-auth: codex login threw: browser boom");
  });

  it("re-probes Claude Code and TUI through default dependencies when TUI is enabled", async () => {
    const resolveClaudeLoginInvocation = vi.fn(() => ({
      ok: true as const,
      command: "/usr/local/bin/claude",
      baseArgs: ["auth", "login"],
    }));
    const runClaudeBrowserLogin = vi.fn(async (options: { onAuthUrl?: (url: string) => void }) => {
      options.onAuthUrl?.("https://auth.example/claude");
      return { ok: true as const };
    });
    const probeClaudeCodeCapability = vi.fn(async () => ({
      state: "ok" as const,
      available: true,
      detectedAt: "2026-06-22T12:00:00.000Z",
    }));
    const probeClaudeCodeTuiCapability = vi.fn(async () => ({
      state: "ok" as const,
      available: true,
      detectedAt: "2026-06-22T12:00:01.000Z",
    }));
    vi.doMock("@first-tree/client", () => ({
      BROWSER_LOGIN_TIMEOUT_MS: 120_000,
      probeClaudeCodeCapability,
      probeClaudeCodeTuiCapability,
      probeCodexCapability: vi.fn(),
      resolveClaudeLoginInvocation,
      resolveCodexRuntimeBinary: vi.fn(),
      runClaudeBrowserLogin,
      runCodexBrowserLogin: vi.fn(),
    }));
    vi.doMock("@first-tree/shared", () => ({
      isRuntimeProviderEnabled: vi.fn((provider: string) => provider === "claude-code-tui"),
    }));
    const { runRuntimeAuthLogin } = await import("../core/runtime-auth-login.js");
    const calls: Array<{ provider: string; entry: CapabilityEntry }> = [];

    await runRuntimeAuthLogin(
      { provider: "claude-code", ref: "default-claude" },
      {
        currentEntry: () => undefined,
        setProviderEntry: async (provider, entry) => {
          calls.push({ provider, entry });
        },
        log: vi.fn(),
      },
    );

    expect(resolveClaudeLoginInvocation).toHaveBeenCalled();
    expect(runClaudeBrowserLogin).toHaveBeenCalledWith({
      command: "/usr/local/bin/claude",
      baseArgs: ["auth", "login"],
      onAuthUrl: expect.any(Function),
    });
    expect(probeClaudeCodeCapability).toHaveBeenCalled();
    expect(probeClaudeCodeTuiCapability).toHaveBeenCalled();
    expect(calls.map((call) => call.provider)).toEqual([
      "claude-code",
      "claude-code",
      "claude-code",
      "claude-code-tui",
    ]);
    expect(calls[1]?.entry.pendingAuth?.authUrl).toBe("https://auth.example/claude");
  });
});
