import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `ClientRuntime` (the CLI-level orchestrator used by `first-tree-hub server
 * start` / `connect <token>`) was silently skipping the per-org Context Tree
 * sync that `AgentRuntime` (the SDK-level orchestrator) performs. Every
 * agent workspace got `.agent/context/` empty and `identity.json.contextTreePath: null`.
 *
 * These tests pin the contract:
 *   1. `ClientRuntime.start()` calls `syncContextTree` once with the runtime's
 *      server URL + access-token provider + user-agent.
 *   2. The resulting binding is forwarded to every slot — both eager ones
 *      registered before `start()`, and slots spawned later via the
 *      `agent:pinned` push path.
 */

const slotInstances: Array<{
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  getQuietGateSnapshot: ReturnType<typeof vi.fn>;
}> = [];
const connectionListeners = new Map<string, (...args: unknown[]) => void>();
const connectionMock = {
  clientId: "client-test",
  on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
    connectionListeners.set(event, fn);
  }),
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
};
const syncContextTreeMock = vi.fn();

vi.mock("@first-tree-hub/client", () => {
  class FakeAgentSlot {
    public readonly name: string;
    public start = vi.fn(async () => ({ displayName: this.name, agentId: this.name }));
    public stop = vi.fn(async () => undefined);
    public getQuietGateSnapshot = vi.fn(() => ({ activeCount: 0, lastActivityMs: 0 }));
    constructor(opts: { name: string }) {
      this.name = opts.name;
      slotInstances.push(this);
    }
  }
  return {
    AgentSlot: FakeAgentSlot,
    ClientConnection: class {
      clientId = connectionMock.clientId;
      on = connectionMock.on;
      connect = connectionMock.connect;
      disconnect = connectionMock.disconnect;
    },
    UpdateManager: { attach: vi.fn(() => ({ dispose: vi.fn() })) },
    createGitMirrorManager: vi.fn(() => ({
      ensureMirror: vi.fn(),
      fetchMirror: vi.fn(),
      createWorktree: vi.fn(),
      removeWorktree: vi.fn(),
      gcMirrors: vi.fn(async () => ({ removed: [] })),
      gcOrphanSessionBranches: vi.fn(async () => ({ scanned: 0, deleted: 0, failed: 0 })),
      mirrorsRoot: "/tmp/fake-mirrors",
    })),
    createLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn().mockReturnThis(),
    })),
    getHandlerFactory: vi.fn(() => vi.fn()),
    registerBuiltinHandlers: vi.fn(),
    syncContextTree: syncContextTreeMock,
  };
});

vi.mock("../core/bootstrap.js", () => ({
  ensureFreshAccessToken: vi.fn(async () => "tok-test"),
}));

vi.mock("../core/output.js", () => ({
  print: {
    status: vi.fn(),
    check: vi.fn(),
    blank: vi.fn(),
    line: vi.fn(),
    result: vi.fn(),
    fail: vi.fn(),
  },
  setJsonMode: vi.fn(),
  isJsonMode: vi.fn(() => false),
}));

vi.mock("../core/version.js", () => ({
  CLI_USER_AGENT: "first-tree-hub-test/0.0.0",
}));

describe("ClientRuntime context-tree wiring", () => {
  beforeEach(() => {
    slotInstances.length = 0;
    connectionListeners.clear();
    syncContextTreeMock.mockReset();
    connectionMock.on.mockClear();
    connectionMock.connect.mockClear();
    connectionMock.disconnect.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("syncs Context Tree at start() and forwards the binding to every slot", async () => {
    const fakeBinding = {
      path: "/tmp/fake-context-tree",
      repoUrl: "https://example.test/tree.git",
      branch: "main",
    };
    syncContextTreeMock.mockResolvedValue(fakeBinding);

    const { ClientRuntime } = await import("../core/client-runtime.js");
    const rt = new ClientRuntime("https://hub.test", "client-test");
    rt.addAgent("alpha", {
      agentId: "agent-alpha",
      runtime: "claude-code",
      session: { idle_timeout: 300, max_sessions: 4 },
      concurrency: 1,
    } as unknown as Parameters<typeof rt.addAgent>[1]);

    await rt.start();

    expect(syncContextTreeMock).toHaveBeenCalledTimes(1);
    const [serverUrl, getAccessToken, log, userAgent] = syncContextTreeMock.mock.calls[0] ?? [];
    expect(serverUrl).toBe("https://hub.test");
    expect(typeof getAccessToken).toBe("function");
    expect(typeof log).toBe("function");
    expect(userAgent).toBe("first-tree-hub-test/0.0.0");

    expect(slotInstances).toHaveLength(1);
    const slot = slotInstances[0];
    if (!slot) throw new Error("slot not constructed");
    expect(slot.start).toHaveBeenCalledTimes(1);
    expect(slot.start.mock.calls[0]?.[0]).toEqual(fakeBinding);
  });

  it("forwards a null binding when Context Tree is unconfigured (graceful degradation)", async () => {
    syncContextTreeMock.mockResolvedValue(null);

    const { ClientRuntime } = await import("../core/client-runtime.js");
    const rt = new ClientRuntime("https://hub.test", "client-test");
    rt.addAgent("alpha", {
      agentId: "agent-alpha",
      runtime: "claude-code",
      session: { idle_timeout: 300, max_sessions: 4 },
      concurrency: 1,
    } as unknown as Parameters<typeof rt.addAgent>[1]);

    await rt.start();

    expect(syncContextTreeMock).toHaveBeenCalledTimes(1);
    const slot = slotInstances[0];
    if (!slot) throw new Error("slot not constructed");
    expect(slot.start).toHaveBeenCalledTimes(1);
    expect(slot.start.mock.calls[0]?.[0]).toBeNull();
  });
});
