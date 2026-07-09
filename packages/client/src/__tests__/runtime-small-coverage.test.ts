import { describe, expect, it, vi } from "vitest";
import { getCliBinding, resetCliBindingForTest, setCliBinding } from "../runtime/cli-binding.js";
import {
  deliveryTokenFromSessionContext,
  noopDeliveryToken,
  type SessionContext,
  type SessionMessage,
} from "../runtime/handler.js";

describe("CLI binding state", () => {
  it("throws loudly when runtime code reads the binding before startup installs it", () => {
    resetCliBindingForTest();

    expect(() => getCliBinding()).toThrow(/CLI binding not initialised/);
  });

  it("stores a defensive copy of the startup binding and allows tests to reset it", () => {
    const binding = { binName: "first-tree-dev", packageName: null };
    setCliBinding(binding);
    binding.binName = "mutated";

    expect(getCliBinding()).toEqual({ binName: "first-tree-dev", packageName: null });

    resetCliBindingForTest();
    expect(() => getCliBinding()).toThrow(/CLI binding not initialised/);
  });
});

describe("Claude browser login invocation resolution", () => {
  it("prefers a resolved on-disk claude executable", async () => {
    vi.resetModules();
    const resolveClaudeCodeExecutable = vi.fn(() => ({ path: "/usr/local/bin/claude", source: "path" }));
    const resolveBundledClaudeBinary = vi.fn();
    vi.doMock("../handlers/claude-executable.js", () => ({ resolveClaudeCodeExecutable }));
    vi.doMock("../runtime/capabilities/claude-code.js", () => ({ resolveBundledClaudeBinary }));

    const { resolveClaudeLoginInvocation } = await import("../runtime/claude-login.js");

    expect(resolveClaudeLoginInvocation({ PATH: "/usr/local/bin" })).toEqual({
      ok: true,
      command: "/usr/local/bin/claude",
      baseArgs: [],
    });
    expect(resolveClaudeCodeExecutable).toHaveBeenCalledWith({ env: { PATH: "/usr/local/bin" } });
    expect(resolveBundledClaudeBinary).not.toHaveBeenCalled();
  });

  it("uses the bundled legacy cli.js through node when no system claude resolves", async () => {
    vi.resetModules();
    vi.doMock("../handlers/claude-executable.js", () => ({
      resolveClaudeCodeExecutable: vi.fn(() => ({ path: undefined, source: "default" })),
    }));
    vi.doMock("../runtime/capabilities/claude-code.js", () => ({
      resolveBundledClaudeBinary: vi.fn(() => ({ kind: "cli-js", path: "/sdk/cli.js" })),
    }));

    const { resolveClaudeLoginInvocation } = await import("../runtime/claude-login.js");

    expect(resolveClaudeLoginInvocation()).toEqual({
      ok: true,
      command: process.execPath,
      baseArgs: ["/sdk/cli.js"],
    });
  });

  it("uses the bundled native binary directly when that is the SDK layout", async () => {
    vi.resetModules();
    vi.doMock("../handlers/claude-executable.js", () => ({
      resolveClaudeCodeExecutable: vi.fn(() => ({ path: undefined, source: "default" })),
    }));
    vi.doMock("../runtime/capabilities/claude-code.js", () => ({
      resolveBundledClaudeBinary: vi.fn(() => ({ kind: "native", path: "/sdk/claude" })),
    }));

    const { resolveClaudeLoginInvocation } = await import("../runtime/claude-login.js");

    expect(resolveClaudeLoginInvocation()).toEqual({
      ok: true,
      command: "/sdk/claude",
      baseArgs: [],
    });
  });

  it("returns a readable failure when neither system nor bundled claude can be located", async () => {
    vi.resetModules();
    vi.doMock("../handlers/claude-executable.js", () => ({
      resolveClaudeCodeExecutable: vi.fn(() => ({ path: undefined, source: "default" })),
    }));
    vi.doMock("../runtime/capabilities/claude-code.js", () => ({
      resolveBundledClaudeBinary: vi.fn(() => {
        throw new Error("native package missing");
      }),
    }));

    const { resolveClaudeLoginInvocation } = await import("../runtime/claude-login.js");

    expect(resolveClaudeLoginInvocation()).toEqual({
      ok: false,
      error: "no `claude` on PATH and the SDK-bundled Claude binary could not be located: native package missing",
    });
  });

  it("builds the browser OAuth command with auth login and the default timeout", async () => {
    vi.resetModules();
    const runBrowserLogin = vi.fn(async () => ({ ok: true as const, authUrl: "https://claude.test/login" }));
    vi.doMock("../runtime/runtime-login.js", () => ({
      BROWSER_LOGIN_TIMEOUT_MS: 1234,
      runBrowserLogin,
    }));

    const { runClaudeBrowserLogin } = await import("../runtime/claude-login.js");
    const onAuthUrl = vi.fn();
    const onRawOutput = vi.fn();
    const spawnFn = vi.fn() as never;
    const signal = new AbortController().signal;

    await expect(
      runClaudeBrowserLogin({
        command: "/usr/bin/claude",
        baseArgs: ["--profile", "work"],
        env: { HOME: "/tmp/home" },
        onAuthUrl,
        onRawOutput,
        signal,
        spawnFn,
      }),
    ).resolves.toEqual({ ok: true, authUrl: "https://claude.test/login" });

    expect(runBrowserLogin).toHaveBeenCalledWith({
      command: "/usr/bin/claude",
      args: ["--profile", "work", "auth", "login"],
      label: "claude auth login",
      env: { HOME: "/tmp/home" },
      onAuthUrl,
      onRawOutput,
      signal,
      timeoutMs: 1234,
      spawnFn,
    });
  });

  it("honors an explicit browser login timeout override", async () => {
    vi.resetModules();
    const runBrowserLogin = vi.fn(async () => ({ ok: false as const, error: "timed out" }));
    vi.doMock("../runtime/runtime-login.js", () => ({
      BROWSER_LOGIN_TIMEOUT_MS: 1234,
      runBrowserLogin,
    }));

    const { runClaudeBrowserLogin } = await import("../runtime/claude-login.js");

    await expect(
      runClaudeBrowserLogin({
        command: "/usr/bin/claude",
        baseArgs: [],
        timeoutMs: 50,
      }),
    ).resolves.toEqual({ ok: false, error: "timed out" });

    expect(runBrowserLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["auth", "login"],
        timeoutMs: 50,
      }),
    );
  });
});

describe("delivery token helpers", () => {
  const message: SessionMessage = {
    id: "019f44e0-0000-7000-8000-000000000001",
    chatId: "chat-1",
    senderId: "agent-human",
    format: "text",
    content: "hello",
    metadata: null,
  };

  it("noopDeliveryToken exposes inert async-safe methods", async () => {
    const token = noopDeliveryToken();

    expect(() => token.processingStarted(message)).not.toThrow();
    expect(() => token.retry([message], "later")).not.toThrow();
    await expect(token.complete(message, { status: "success" })).resolves.toBeUndefined();
    await expect(
      token.terminalRejected(message, "terminal", { kind: "chat_message", messageId: "msg-1" }),
    ).resolves.toBeUndefined();
  });

  it("adapts a SessionContext to the DeliveryToken contract", async () => {
    const markMessagesConsumed = vi.fn();
    const finishTurn = vi.fn(async () => {});
    const retryTurn = vi.fn();
    const ctx = {
      markMessagesConsumed,
      finishTurn,
      retryTurn,
    } as unknown as SessionContext;

    const token = deliveryTokenFromSessionContext(ctx);

    token.processingStarted(message);
    await token.complete([message], { status: "error", errorKind: "transient" });
    token.retry(message, "network");
    await token.terminalRejected(message, "terminal", { kind: "server_terminal_record", recordId: "rec-1" });

    expect(markMessagesConsumed).toHaveBeenCalledWith(message);
    expect(finishTurn).toHaveBeenCalledWith([message], { status: "error", errorKind: "transient" });
    expect(retryTurn).toHaveBeenCalledWith(message, "network");
    expect(retryTurn).toHaveBeenCalledWith(message, "terminal_rejected_without_delivery_token:terminal");
  });
});
