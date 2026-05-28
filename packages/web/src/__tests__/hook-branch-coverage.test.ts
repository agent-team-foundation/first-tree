import type { AgentRuntimeConfig, ClientCapabilities } from "@first-tree/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

type UnknownFn = (...args: unknown[]) => unknown;
type Cleanup = () => void;
type EffectFn = () => undefined | Cleanup;
type ClaudeRuntimePayload = Extract<AgentRuntimeConfig["payload"], { kind: "claude-code" }>;
type ReactMockControl = {
  beginRender: () => void;
  cleanups: Cleanup[];
  slots: unknown[];
};

const apiPostMock = vi.fn();
const getAgentClientStatusMock = vi.fn();
const getClientCapabilitiesMock = vi.fn();
const listClientsMock = vi.fn();
const reportOnboardingEventMock = vi.fn();
const runVisibilityAwareIntervalMock = vi.fn();
const setReadStateMock = vi.fn();
const writeOnboardingAgentUuidMock = vi.fn();

function createReactMock(seed: unknown[] = []): ReactMockControl {
  let slotCursor = 0;
  const control: ReactMockControl = {
    beginRender: () => {
      slotCursor = 0;
    },
    cleanups: [],
    slots: [...seed],
  };

  vi.doMock("react", () => {
    const react = {
      useCallback: (fn: UnknownFn) => fn,
      useEffect: (fn: EffectFn) => {
        const cleanup = fn();
        if (typeof cleanup === "function") control.cleanups.push(cleanup);
      },
      useMemo: (fn: UnknownFn) => fn(),
      useRef: (initial: unknown) => ({ current: initial }),
      useState: (initial: unknown) => {
        const index = slotCursor;
        slotCursor += 1;
        if (index >= control.slots.length) {
          control.slots[index] = typeof initial === "function" ? (initial as UnknownFn)() : initial;
        }
        const setState = (next: unknown): void => {
          const previous = control.slots[index];
          control.slots[index] = typeof next === "function" ? (next as UnknownFn)(previous) : next;
        };
        return [control.slots[index], setState];
      },
    };
    return { ...react, default: react };
  });

  return control;
}

function readyCaps(overrides: Partial<ClientCapabilities[string]> = {}): ClientCapabilities[string] {
  return {
    state: "ok",
    available: true,
    authenticated: true,
    authMethod: "none",
    detectedAt: "2026-05-28T00:00:00.000Z",
    ...overrides,
  };
}

function runtimeConfig(overrides: Partial<ClaudeRuntimePayload> = {}): AgentRuntimeConfig {
  const payload: ClaudeRuntimePayload = {
    kind: "claude-code",
    model: "claude-sonnet-4-5",
    prompt: { append: "Baseline prompt" },
    mcpServers: [{ name: "github", transport: "stdio", command: "npx", args: ["-y", "github"] }],
    env: [{ key: "GITHUB_TOKEN", value: "__FIRST_TREE_REDACTED__", sensitive: true }],
    gitRepos: [{ url: "https://github.com/agent-team-foundation/first-tree", ref: "main" }],
    ...overrides,
  };
  return {
    agentId: "agent-1",
    updatedAt: "2026-05-28T00:00:00.000Z",
    updatedBy: "user-1",
    version: 3,
    payload,
  };
}

function installCommonMocks(): void {
  vi.doMock("../api/activity.js", () => ({
    getClientCapabilities: getClientCapabilitiesMock,
    listClients: listClientsMock,
  }));
  vi.doMock("../api/agent-config.js", () => ({
    getAgentClientStatus: getAgentClientStatusMock,
  }));
  vi.doMock("../api/client.js", () => ({
    api: { post: apiPostMock },
    withOrg: (path: string) => `/org${path}`,
  }));
  vi.doMock("../api/onboarding-events.js", () => ({
    reportOnboardingEvent: reportOnboardingEventMock,
  }));
  vi.doMock("../api/read-state-store.js", () => ({
    setReadState: setReadStateMock,
  }));
  vi.doMock("../lib/visibility-interval.js", () => ({
    runVisibilityAwareInterval: runVisibilityAwareIntervalMock,
  }));
  vi.doMock("../utils/onboarding-flags.js", () => ({
    writeOnboardingAgentUuid: writeOnboardingAgentUuidMock,
  }));
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("web hook branch coverage", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    apiPostMock.mockReset();
    getAgentClientStatusMock.mockReset();
    getClientCapabilitiesMock.mockReset();
    listClientsMock.mockReset();
    reportOnboardingEventMock.mockReset();
    runVisibilityAwareIntervalMock.mockReset();
    setReadStateMock.mockReset();
    writeOnboardingAgentUuidMock.mockReset();
    installCommonMocks();
  });

  it("exercises config draft list operations, summary, resets, and patch serialization", async () => {
    const control = createReactMock();
    const { ENV_REDACTED_PLACEHOLDER } = await import("@first-tree/shared");
    const { createConfigDraft, useConfigDraft } = await import("../pages/agent-detail/use-config-draft.js");
    const baseline = runtimeConfig();
    const draft = createConfigDraft(baseline);
    draft.promptAppend = "Updated prompt";
    draft.model = "claude-opus";
    const firstMcp = draft.mcp[0];
    if (!firstMcp || firstMcp.value.transport !== "stdio") throw new Error("expected stdio MCP fixture");
    draft.mcp[0] = { ...firstMcp, value: { ...firstMcp.value, command: "node" }, status: "modified" };
    const firstEnv = draft.env[0];
    if (!firstEnv) throw new Error("expected env fixture");
    draft.env[0] = {
      ...firstEnv,
      value: { key: "GITHUB_TOKEN", value: ENV_REDACTED_PLACEHOLDER, sensitive: true },
      status: "modified",
    };
    const firstGit = draft.git[0];
    if (!firstGit) throw new Error("expected git fixture");
    draft.git[0] = { ...firstGit, status: "deleted" };
    control.slots[0] = baseline;
    control.slots[1] = draft;

    control.beginRender();
    const active = useConfigDraft(baseline);
    expect(active.summary.dirtySections).toEqual(["prompt", "model", "mcp", "env", "git"]);
    expect(active.buildPayloadPatch()).toMatchObject({
      prompt: { append: "Updated prompt" },
      model: "claude-opus",
      env: [{ key: "GITHUB_TOKEN", value: ENV_REDACTED_PLACEHOLDER, sensitive: true }],
      gitRepos: [],
    });

    active.addMcp({ name: "linear", transport: "stdio", command: "node" });
    active.updateMcp("mcp-1", { name: "github", transport: "stdio", command: "pnpm" });
    active.deleteMcp("mcp-1");
    active.undoDeleteMcp("mcp-1");
    active.addEnv({ key: "NEW_TOKEN", value: "secret", sensitive: true });
    active.deleteEnv("env-2");
    active.updateEnv("env-1", { key: "GITHUB_TOKEN", value: "fresh", sensitive: true });
    active.undoDeleteEnv("env-1");
    active.addGit({ url: "https://github.com/example/new", ref: "main" });
    active.updateGit("git-1", { url: "https://github.com/example/old", ref: "dev" });
    active.deleteGit("git-1");
    active.undoDeleteGit("git-1");
    active.setPromptAppend("Another prompt");
    active.revertPrompt();
    active.setModel("claude-haiku");
    active.revertModel();
    active.resetToConfig(runtimeConfig({ model: "claude-haiku" }));
    active.resetAll();

    control.slots[0] = null;
    control.slots[1] = null;
    control.beginRender();
    const empty = useConfigDraft(undefined);
    expect(empty.buildPayloadPatch()).toEqual({});
  }, 15_000);

  it("exercises computer connection detection, token refresh, runtime preference, and error paths", async () => {
    vi.stubGlobal("window", {
      setTimeout: (fn: UnknownFn) => {
        fn();
        return 1;
      },
      clearTimeout: vi.fn(),
    });
    const connected = {
      id: "client-1",
      hostname: "ada-workstation",
      status: "connected",
      lastSeenAt: "2026-05-28T00:00:00.000Z",
    };
    const stale = { ...connected, id: "client-0", status: "offline", lastSeenAt: "2026-05-27T00:00:00.000Z" };
    const capabilities = {
      "claude-code": readyCaps(),
      codex: readyCaps({ state: "unauthenticated", authenticated: false }),
      local: readyCaps(),
    };
    runVisibilityAwareIntervalMock.mockImplementation((tick: UnknownFn) => {
      void tick();
      return vi.fn();
    });
    listClientsMock.mockResolvedValue([stale, connected]);
    getClientCapabilitiesMock.mockResolvedValue({ capabilities });
    apiPostMock.mockResolvedValue({
      token: "connect-token",
      expiresIn: 60,
      bootstrapCommand: "first-tree login token",
    });

    let control = createReactMock([connected, capabilities, "client-1", null, null, null, null, null]);
    const { useComputerConnection } = await import("../pages/onboarding/use-computer-connection.js");
    control.beginRender();
    const active = useComputerConnection(true);
    await flushAsync();
    expect(active.okRuntimes).toEqual(["claude-code", "local"]);
    expect(control.slots[3]).toBe("claude-code");
    expect(getClientCapabilitiesMock).toHaveBeenCalledWith("client-1");

    vi.resetModules();
    installCommonMocks();
    runVisibilityAwareIntervalMock.mockImplementation((tick: UnknownFn) => {
      void tick();
      return vi.fn();
    });
    listClientsMock.mockResolvedValue([]);
    apiPostMock.mockRejectedValue(new Error("token failed"));
    control = createReactMock([null, null, null, null, "old-token", Date.now() - 1, null, null]);
    const { useComputerConnection: useComputerConnectionExpired } = await import(
      "../pages/onboarding/use-computer-connection.js"
    );
    control.beginRender();
    const expired = useComputerConnectionExpired(true);
    await flushAsync();
    expect(expired.cliCommand).toContain("old-token");

    vi.resetModules();
    installCommonMocks();
    runVisibilityAwareIntervalMock.mockImplementation((tick: UnknownFn) => {
      void tick();
      return vi.fn();
    });
    listClientsMock.mockRejectedValue(new Error("network down"));
    apiPostMock.mockResolvedValue({
      token: "new-token",
      expiresIn: 60,
      bootstrapCommand: "first-tree login new-token",
    });
    control = createReactMock([null, null, null, null, null, null, null, null]);
    const { useComputerConnection: useComputerConnectionNoClient } = await import(
      "../pages/onboarding/use-computer-connection.js"
    );
    control.beginRender();
    useComputerConnectionNoClient(true);
    await flushAsync();
    expect(control.slots[4]).toBe("new-token");

    vi.resetModules();
    installCommonMocks();
    control = createReactMock([
      connected,
      { custom: readyCaps() },
      "client-1",
      "missing-runtime",
      null,
      null,
      null,
      null,
    ]);
    const { useComputerConnection: useComputerConnectionCustom } = await import(
      "../pages/onboarding/use-computer-connection.js"
    );
    control.beginRender();
    useComputerConnectionCustom(true);
    expect(control.slots[3]).toBe("custom");

    vi.resetModules();
    installCommonMocks();
    runVisibilityAwareIntervalMock.mockClear();
    control = createReactMock();
    const { useComputerConnection: useComputerConnectionDisabled } = await import(
      "../pages/onboarding/use-computer-connection.js"
    );
    control.beginRender();
    expect(useComputerConnectionDisabled(false).capabilitiesLoaded).toBe(false);
    expect(runVisibilityAwareIntervalMock).not.toHaveBeenCalled();
  });

  it("exercises agent creation success, retry, timeout, and failure paths", async () => {
    vi.stubGlobal("setTimeout", (fn: UnknownFn) => {
      fn();
      return 1;
    });
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    let control = createReactMock();
    let online = vi.fn();
    apiPostMock.mockResolvedValue({ uuid: "agent-1" });
    getAgentClientStatusMock.mockResolvedValue({ online: true });
    const { useAgentCreation } = await import("../pages/onboarding/use-agent-creation.js");
    control.beginRender();
    const first = useAgentCreation(online);
    await first.create({
      displayName: " Release Helper ",
      clientId: "client-1",
      runtimeProvider: "claude-code",
      visibility: "organization",
      organizationId: "org-1",
    });
    await first.retry();
    await first.create({
      displayName: "   ",
      clientId: "client-1",
      runtimeProvider: "claude-code",
      visibility: "private",
      organizationId: null,
    });
    expect(apiPostMock).toHaveBeenCalledWith(
      "/org/agents",
      expect.objectContaining({ displayName: "Release Helper", name: "release-helper" }),
    );
    expect(writeOnboardingAgentUuidMock).toHaveBeenCalledWith("agent-1");
    expect(reportOnboardingEventMock).toHaveBeenCalledWith("agent_created", { runtimeProvider: "claude-code" });
    expect(online).toHaveBeenCalledWith("agent-1");

    vi.resetModules();
    installCommonMocks();
    control = createReactMock();
    online = vi.fn();
    apiPostMock.mockRejectedValue("nope");
    const { useAgentCreation: useAgentCreationFailure } = await import("../pages/onboarding/use-agent-creation.js");
    control.beginRender();
    const failed = useAgentCreationFailure(online);
    await failed.create({
      displayName: "Broken",
      clientId: "client-1",
      runtimeProvider: "codex",
      visibility: "private",
      organizationId: null,
    });
    await failed.retry();
    expect(control.slots[1]).toBe("Failed to create your agent");

    vi.resetModules();
    installCommonMocks();
    dateSpy.mockRestore();
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(31_000);
    control = createReactMock();
    apiPostMock.mockResolvedValue({ uuid: "agent-timeout" });
    getAgentClientStatusMock.mockRejectedValue(new Error("not ready"));
    const { useAgentCreation: useAgentCreationTimeout } = await import("../pages/onboarding/use-agent-creation.js");
    control.beginRender();
    const timedOut = useAgentCreationTimeout(vi.fn());
    await timedOut.create({
      displayName: "Slow Agent",
      clientId: "client-1",
      runtimeProvider: "codex",
      visibility: "private",
      organizationId: null,
    });
    expect(control.slots[0]).toBe("timeout");
  });

  it("exercises read tracker scroll, mutation, debounce, hidden-tab, fallback, and cleanup branches", async () => {
    const addListener = vi.fn();
    const removeListener = vi.fn();
    vi.stubGlobal("document", {
      addEventListener: addListener,
      removeEventListener: removeListener,
      visibilityState: "hidden",
    });
    vi.stubGlobal("setTimeout", (fn: UnknownFn) => {
      fn();
      return 1;
    });
    vi.stubGlobal("clearTimeout", vi.fn());
    vi.stubGlobal(
      "MutationObserver",
      class MutationObserver {
        private readonly fn: UnknownFn;
        constructor(fn: UnknownFn) {
          this.fn = fn;
        }
        observe(): void {
          this.fn();
        }
        disconnect(): void {}
      },
    );
    setReadStateMock.mockResolvedValue(undefined);
    const node = (id: string, bottom: number) => ({
      dataset: { messageId: id },
      getBoundingClientRect: () => ({ bottom }),
    });
    const container = {
      addEventListener: vi.fn(),
      getBoundingClientRect: () => ({ bottom: 100 }),
      querySelectorAll: vi.fn(() => [node("msg-1", 40), node("msg-2", 100), node("msg-3", 140)]),
      removeEventListener: vi.fn(),
    };
    const onWrite = vi.fn();
    const onBottomVisibleChange = vi.fn();
    const control = createReactMock();
    const { useReadTracker } = await import("../hooks/use-read-tracker.js");
    control.beginRender();
    useReadTracker({
      containerRef: { current: container as unknown as HTMLElement },
      messages: [
        { id: "msg-1", createdAt: "2026-05-28T00:00:00.000Z" },
        { id: "msg-2", createdAt: "2026-05-28T00:01:00.000Z" },
        { id: "msg-3", createdAt: "2026-05-28T00:02:00.000Z" },
      ],
      chatId: "chat-1",
      onWrite,
      onBottomVisibleChange,
      writeDebounceMs: 1,
    });
    for (const cleanup of control.cleanups.splice(0)) cleanup();
    await flushAsync();
    expect(setReadStateMock).toHaveBeenCalledWith("chat-1", "msg-2", "msg-3");
    expect(onBottomVisibleChange).toHaveBeenCalledWith("msg-2");
    expect(removeListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));

    vi.resetModules();
    installCommonMocks();
    const fallbackControl = createReactMock();
    const shortContainer = {
      addEventListener: vi.fn(),
      getBoundingClientRect: () => ({ bottom: 50 }),
      querySelectorAll: vi.fn(() => [node("first", 200)]),
      removeEventListener: vi.fn(),
    };
    const { useReadTracker: useReadTrackerFallback } = await import("../hooks/use-read-tracker.js");
    fallbackControl.beginRender();
    useReadTrackerFallback({
      containerRef: { current: shortContainer as unknown as HTMLElement },
      messages: [{ id: "first", createdAt: "2026-05-28T00:00:00.000Z" }],
      chatId: "chat-2",
      onBottomVisibleChange,
      writeDebounceMs: 1,
    });
    await flushAsync();
    expect(onBottomVisibleChange).toHaveBeenCalledWith("first");

    vi.resetModules();
    installCommonMocks();
    const emptyControl = createReactMock();
    const { useReadTracker: useReadTrackerEmpty } = await import("../hooks/use-read-tracker.js");
    emptyControl.beginRender();
    useReadTrackerEmpty({
      containerRef: { current: null },
      messages: [],
      chatId: "chat-empty",
    });
    expect(setReadStateMock).not.toHaveBeenCalledWith("chat-empty", expect.anything(), expect.anything());
  });
});
