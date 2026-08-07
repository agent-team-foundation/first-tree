import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../commands/types.js";

const mocks = vi.hoisted(() => ({
  hook: vi.fn(),
  issueSync: vi.fn(),
  knownCompatibleSession: vi.fn(),
  readInstall: vi.fn(),
  resolveRelease: vi.fn(),
  assertPayloadHealthy: vi.fn(),
  consumeNextSession: vi.fn(),
  resolveProject: vi.fn(),
  activateExternal: vi.fn(),
  renderResponse: vi.fn(),
}));

vi.mock("../core/output.js", () => ({ print: { hook: mocks.hook } }));
vi.mock("../core/channel.js", () => ({ channelConfig: { channel: "dev" } }));
vi.mock("../core/context-integration/adapter-sync.js", () => ({
  AdapterSyncRejectedError: class AdapterSyncRejectedError extends Error {},
  hasKnownCompatibleContextAdapterSession: mocks.knownCompatibleSession,
  issueAdapterSyncAction: mocks.issueSync,
}));
vi.mock("../core/context-integration/manifest.js", () => ({
  readContextIntegrationInstallManifest: mocks.readInstall,
}));
vi.mock("../core/context-integration/release.js", () => ({
  resolveContextIntegrationRelease: mocks.resolveRelease,
}));
vi.mock("../core/context-integration/adapter-payload-health.js", () => ({
  assertContextAdapterPayloadHealthy: mocks.assertPayloadHealthy,
}));
vi.mock("../core/context-integration/adapter-observation.js", () => ({
  consumeContextAdapterNextSessionObligation: mocks.consumeNextSession,
}));
vi.mock("../core/context-integration/client-preflight.js", () => ({
  resolveSessionContextProject: mocks.resolveProject,
}));
vi.mock("../core/context-integration/activation.js", () => ({
  activateExternalContext: mocks.activateExternal,
  renderProviderSessionStartResponse: mocks.renderResponse,
}));

import { runContextActivate } from "../commands/context/activate.js";

function context(options: Record<string, unknown>): CommandContext {
  return {
    command: { opts: () => options } as unknown as Command,
    options: { json: false, debug: false, quiet: false },
  };
}

describe("context activate command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("FIRST_TREE_AGENT_ID", "");
    vi.stubEnv("FIRST_TREE_CHAT_ID", "");
    vi.stubEnv("FIRST_TREE_SERVER_URL", "https://first-tree.example");
    mocks.readInstall.mockReturnValue({
      accountClientId: "client_1234abcd",
      channel: "dev",
      loaderProtocolVersion: 1,
      adapterVersion: "1.0.0",
      adapterDigest: "sha256:old",
    });
    mocks.resolveRelease.mockReturnValue({
      manifest: { providers: { codex: { adapterVersion: "1.1.0", adapterDigest: "sha256:new" } } },
    });
    mocks.issueSync.mockReturnValue({
      code: "adapter_sync_required",
      command: "first-tree-dev --json context adapter-sync --provider codex --challenge opaque",
    });
    mocks.assertPayloadHealthy.mockReturnValue(undefined);
    mocks.knownCompatibleSession.mockReturnValue(false);
    mocks.resolveProject.mockReturnValue({ kind: "pathless", project: { kind: "pathless" } });
    mocks.activateExternal.mockResolvedValue({ outcome: "connected" });
    mocks.renderResponse.mockReturnValue({ continue: true, systemMessage: "connected" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("skips the external Context hook inside a managed First Tree agent session", async () => {
    vi.stubEnv("FIRST_TREE_AGENT_ID", "agent-1");
    vi.stubEnv("FIRST_TREE_CHAT_ID", "chat-1");

    await runContextActivate(context({ provider: "codex", adapterDigest: "sha256:old" }), {
      readHookInput: () => ({ session_id: "session-a" }),
    });

    expect(mocks.resolveRelease).not.toHaveBeenCalled();
    expect(mocks.issueSync).not.toHaveBeenCalled();
    expect(mocks.hook).toHaveBeenCalledWith({ continue: true });
  });

  it.each([
    ["agent", "agent-1", ""],
    ["chat", "", "chat-1"],
  ])("keeps external activation enabled when only the managed %s marker is present", async (_marker, agentId, chatId) => {
    vi.stubEnv("FIRST_TREE_AGENT_ID", agentId);
    vi.stubEnv("FIRST_TREE_CHAT_ID", chatId);

    await runContextActivate(context({ provider: "codex", adapterDigest: "sha256:old" }), {
      readHookInput: () => ({ session_id: "session-a" }),
    });

    expect(mocks.issueSync).toHaveBeenCalledOnce();
    expect(mocks.hook.mock.calls[0]?.[0]).toMatchObject({
      continue: true,
      hookSpecificOutput: { hookEventName: "SessionStart" },
    });
  });

  it("returns a bounded exact sync action without installing or treating a routine update as failure", async () => {
    const started = performance.now();

    await runContextActivate(context({ provider: "codex", adapterDigest: "sha256:old" }), {
      readHookInput: () => ({ session_id: "session-a" }),
    });

    expect(performance.now() - started).toBeLessThan(1_000);
    expect(mocks.issueSync).toHaveBeenCalledOnce();
    const response = mocks.hook.mock.calls[0]?.[0];
    expect(response.systemMessage).toContain("update is available");
    expect(response.systemMessage).toContain("remains usable");
    expect(response.hookSpecificOutput.additionalContext).toContain("adapter_sync_required");
    expect(response.hookSpecificOutput.additionalContext).toContain("context adapter-sync");
    expect(response.hookSpecificOutput.additionalContext).toContain("currentAdapterUsable=true");
    expect(response.hookSpecificOutput.additionalContext).not.toContain("context repair");
  });

  it("keeps a compatible session usable when issuing the automatic update is temporarily unavailable", async () => {
    mocks.issueSync.mockImplementation(() => {
      throw new Error("temporary local write failure");
    });

    await runContextActivate(context({ provider: "codex", adapterDigest: "sha256:old" }), {
      readHookInput: () => ({ session_id: "session-a" }),
    });

    const response = mocks.hook.mock.calls[0]?.[0];
    expect(response.systemMessage).toContain("remains usable");
    expect(response.hookSpecificOutput.additionalContext).toContain("update_deferred");
    expect(response.hookSpecificOutput.additionalContext).not.toContain("temporary local write failure");
    expect(response.hookSpecificOutput.additionalContext).not.toContain("context repair");
  });

  it("keeps incompatible or corrupt adapter state out of the routine-update path", async () => {
    mocks.readInstall.mockReturnValue({
      accountClientId: "client_1234abcd",
      channel: "dev",
      loaderProtocolVersion: 0,
      adapterVersion: "1.0.0",
      adapterDigest: "sha256:old",
    });
    mocks.issueSync.mockImplementation(() => {
      throw new Error("repair required");
    });

    await runContextActivate(context({ provider: "codex", adapterDigest: "sha256:old" }), {
      readHookInput: () => ({ session_id: "session-a" }),
    });

    const response = mocks.hook.mock.calls[0]?.[0];
    expect(response.systemMessage).toContain("needs attention");
    expect(response.systemMessage).not.toContain("remains usable");
    expect(response.hookSpecificOutput.additionalContext).toContain("context repair");
  });

  it("does not trust a self-reported digest when the installed payload has drifted", async () => {
    mocks.assertPayloadHealthy.mockImplementation(() => {
      throw new Error("provider cache drifted");
    });
    mocks.issueSync.mockImplementation(() => {
      throw new Error("repair required");
    });

    await runContextActivate(context({ provider: "codex", adapterDigest: "sha256:old" }), {
      readHookInput: () => ({ session_id: "session-a" }),
    });

    const response = mocks.hook.mock.calls[0]?.[0];
    expect(response.systemMessage).toContain("needs attention");
    expect(response.hookSpecificOutput.additionalContext).toContain("context repair");
  });

  it("consumes the Claude next-session marker before automatic routing", async () => {
    mocks.readInstall.mockReturnValue({
      accountClientId: "client_1234abcd",
      channel: "dev",
      loaderProtocolVersion: 1,
      adapterVersion: "1.0.2",
      adapterDigest: "sha256:current",
    });
    mocks.resolveRelease.mockReturnValue({
      manifest: {
        providers: { "claude-code": { adapterVersion: "1.0.2", adapterDigest: "sha256:current" } },
      },
    });

    await runContextActivate(context({ provider: "claude-code", adapterDigest: "sha256:current" }), {
      readHookInput: () => ({ session_id: "session-new", cwd: "/work", source: "startup" }),
    });

    expect(mocks.consumeNextSession).toHaveBeenCalledWith({
      provider: "claude-code",
      adapterDigest: "sha256:current",
      sessionStartSource: "startup",
    });
    expect(mocks.resolveProject).toHaveBeenCalledAfter(mocks.consumeNextSession);
    expect(mocks.activateExternal).toHaveBeenCalledOnce();
    expect(mocks.hook).toHaveBeenCalledWith({ continue: true, systemMessage: "connected" });
  });

  it.each([
    "resume",
    "clear",
    "compact",
  ])("keeps an upgraded Claude %s lifecycle event on its session-bound compatible adapter", async (source) => {
    mocks.readInstall.mockReturnValue({
      accountClientId: "client_1234abcd",
      channel: "dev",
      loaderProtocolVersion: 1,
      adapterVersion: "1.0.2",
      adapterDigest: "sha256:current",
    });
    mocks.resolveRelease.mockReturnValue({
      manifest: {
        providers: { "claude-code": { adapterVersion: "1.0.2", adapterDigest: "sha256:current" } },
      },
    });
    mocks.knownCompatibleSession.mockReturnValue(true);

    await runContextActivate(context({ provider: "claude-code", adapterDigest: "sha256:old" }), {
      readHookInput: () => ({ session_id: "session-existing", cwd: "/work", source }),
    });

    expect(mocks.knownCompatibleSession).toHaveBeenCalledWith(
      {
        provider: "claude-code",
        sessionId: "session-existing",
        suppliedAdapterDigest: "sha256:old",
      },
      expect.objectContaining({ driver: expect.anything() }),
    );
    expect(mocks.issueSync).not.toHaveBeenCalled();
    expect(mocks.consumeNextSession).toHaveBeenCalledWith({
      provider: "claude-code",
      adapterDigest: "sha256:old",
      sessionStartSource: source,
    });
    expect(mocks.activateExternal).toHaveBeenCalledOnce();
    expect(JSON.stringify(mocks.hook.mock.calls[0]?.[0])).not.toContain("context repair");
  });
});
