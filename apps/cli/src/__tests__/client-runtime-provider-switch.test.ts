import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #552 — switching an agent's runtime provider must reach an already
 * bound agent without a daemon restart:
 *
 *   Fix A: an `agent:pinned` push whose `runtimeProvider` differs from the
 *     running slot hot-swaps it (rewrite agent.yaml → stop old slot → rebuild
 *     with the new handler factory → restart).
 *   Fix B: a bind rejected with `runtime_provider_mismatch` re-fetches the
 *     authoritative provider from /me/pinned-agents and runs the same swap,
 *     instead of leaving the bind permanently disabled.
 */

type FakeSlot = {
  agentId: string;
  name: string;
  type: string;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  getQuietGateSnapshot: ReturnType<typeof vi.fn>;
};

const slotInstances: FakeSlot[] = [];
const connectionListeners = new Map<string, (...args: unknown[]) => void>();
const killAllMock = vi.fn(async () => undefined);
const sweepMock = vi.fn(async () => ({ removed: [] as string[] }));
// Default: every built-in provider has a handler. Individual tests override
// the implementation to simulate a build that predates a provider.
const hasHandlerMock = vi.fn((type: string) => ["claude-code", "claude-code-tui", "codex"].includes(type));
let connectionMaxListeners = 10;
const connectionMock = {
  clientId: "client-test",
  on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
    connectionListeners.set(event, fn);
  }),
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
  emit: vi.fn(),
  isPaused: vi.fn(() => false),
  getPausedReason: vi.fn(() => null),
  clearPaused: vi.fn(),
  getMaxListeners: vi.fn(() => connectionMaxListeners),
  setMaxListeners: vi.fn((n: number) => {
    connectionMaxListeners = n;
  }),
};

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: actual,
    // No-op watcher: these tests drive handleAgentPinned directly; the real
    // recursive watcher would only add debounce noise.
    watch: vi.fn(() => ({ close: vi.fn(), on: vi.fn() })),
  };
});

vi.mock("@first-tree/client", () => {
  class FakeAgentSlot {
    public readonly agentId: string;
    public readonly name: string;
    public readonly type: string;
    public start = vi.fn(async () => ({ displayName: this.name, agentId: this.agentId }));
    public stop = vi.fn(async () => undefined);
    public getQuietGateSnapshot = vi.fn(() => ({ activeCount: 0, lastActivityMs: 0 }));
    constructor(opts: { agentId: string; name: string; type: string }) {
      this.agentId = opts.agentId;
      this.name = opts.name;
      this.type = opts.type;
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
      emit = connectionMock.emit;
      isPaused = connectionMock.isPaused;
      getPausedReason = connectionMock.getPausedReason;
      clearPaused = connectionMock.clearPaused;
      getMaxListeners = connectionMock.getMaxListeners;
      setMaxListeners = connectionMock.setMaxListeners;
    },
    UpdateManager: { attach: vi.fn(() => ({ dispose: vi.fn() })) },
    createGitMirrorManager: vi.fn(() => ({
      ensureSourceRepo: vi.fn(),
      removeSourceRepo: vi.fn(),
      sweepLegacyMirrors: sweepMock,
      legacyMirrorsRoot: "/tmp/fake-mirrors",
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
    decideRepairForBindReject: vi.fn((reason: string) =>
      reason === "runtime_provider_mismatch" ? { kind: "restart" } : { kind: "ignore" },
    ),
    getChildProcessRegistry: vi.fn(() => ({ killAll: killAllMock })),
    getHandlerFactory: vi.fn(() => vi.fn()),
    hasHandler: hasHandlerMock,
    registerBuiltinHandlers: vi.fn(),
  };
});

vi.mock("../core/bootstrap.js", () => ({
  ensureFreshAccessToken: vi.fn(async () => "tok-test"),
}));

vi.mock("../core/runtime-provider-reconcile.js", () => ({
  listPinnedAgents: vi.fn(async () => []),
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
  CLI_USER_AGENT: "first-tree-test/0.0.0",
}));

type RuntimeCtor = typeof import("../core/client-runtime.js").ClientRuntime;
type Runtime = InstanceType<RuntimeCtor>;

const AGENT_CONFIG_BASE = {
  session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
  concurrency: 1,
};

describe("ClientRuntime runtime-provider switching (issue #552)", () => {
  const originalHome = process.env.FIRST_TREE_HOME;
  let home: string;
  let agentsDir: string;

  beforeEach(() => {
    vi.resetModules();
    home = mkdtempSync(join(tmpdir(), "ft-provider-switch-"));
    process.env.FIRST_TREE_HOME = home;
    agentsDir = join(home, "config", "agents");
    mkdirSync(agentsDir, { recursive: true });
    slotInstances.length = 0;
    connectionListeners.clear();
    connectionMaxListeners = 10;
    killAllMock.mockClear();
    sweepMock.mockReset();
    sweepMock.mockResolvedValue({ removed: [] });
    hasHandlerMock.mockReset();
    hasHandlerMock.mockImplementation((type: string) => ["claude-code", "claude-code-tui", "codex"].includes(type));
    connectionMock.on.mockClear();
    connectionMock.connect.mockClear();
    connectionMock.disconnect.mockClear();
    connectionMock.emit.mockClear();
    connectionMock.clearPaused.mockClear();
    connectionMock.isPaused.mockReset();
    connectionMock.isPaused.mockReturnValue(false);
    connectionMock.getPausedReason.mockReset();
    connectionMock.getPausedReason.mockReturnValue(null);
    connectionMock.getMaxListeners.mockClear();
    connectionMock.setMaxListeners.mockClear();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.FIRST_TREE_HOME;
    else process.env.FIRST_TREE_HOME = originalHome;
    vi.clearAllMocks();
  });

  function writeAgentYaml(name: string, body: string): string {
    const dir = join(agentsDir, name);
    mkdirSync(dir, { recursive: true });
    const yamlPath = join(dir, "agent.yaml");
    writeFileSync(yamlPath, body);
    return yamlPath;
  }

  async function makeRuntime(): Promise<Runtime> {
    const { ClientRuntime } = await import("../core/client-runtime.js");
    const rt = new ClientRuntime("https://first-tree.test", "client-test");
    rt.watchAgentsDir(agentsDir);
    return rt;
  }

  function addAgent(rt: Runtime, name: string, agentId: string, runtime: string): void {
    rt.addAgent(name, {
      agentId,
      runtime,
      ...AGENT_CONFIG_BASE,
    } as unknown as Parameters<Runtime["addAgent"]>[1]);
  }

  function firePinned(agentId: string, name: string, runtimeProvider: string): void {
    const pinned = connectionListeners.get("agent:pinned");
    if (!pinned) throw new Error("agent:pinned listener missing");
    pinned({ agentId, name, runtimeProvider });
  }

  function fireBindRejected(reason: string, agentId: string): void {
    const rejected = connectionListeners.get("agent:bind:rejected");
    if (!rejected) throw new Error("agent:bind:rejected listener missing");
    rejected(reason, agentId);
  }

  it("hot-swaps the slot when agent:pinned carries a different runtime provider", async () => {
    const yamlPath = writeAgentYaml("alpha", "agentId: agent-1\nruntime: claude-code\nconcurrency: 2\n");
    const rt = await makeRuntime();
    addAgent(rt, "alpha", "agent-1", "claude-code");
    await rt.start();
    const oldSlot = slotInstances[0];
    if (!oldSlot) throw new Error("initial slot missing");
    expect(oldSlot.type).toBe("claude-code");

    firePinned("agent-1", "alpha", "claude-code-tui");

    await vi.waitFor(() => expect(slotInstances).toHaveLength(2));
    const newSlot = slotInstances[1];
    if (!newSlot) throw new Error("swapped slot missing");
    expect(oldSlot.stop).toHaveBeenCalled();
    expect(newSlot.type).toBe("claude-code-tui");
    expect(newSlot.agentId).toBe("agent-1");
    await vi.waitFor(() => expect(newSlot.start).toHaveBeenCalled());

    // agent.yaml is rewritten to the authoritative provider, preserving the
    // other fields the operator may have set locally.
    const text = readFileSync(yamlPath, "utf8");
    expect(text).toContain("runtime: claude-code-tui");
    expect(text).toContain("concurrency: 2");
    await rt.stop();
  });

  it("does not swap when agent:pinned carries the provider already running", async () => {
    writeAgentYaml("alpha", "agentId: agent-1\nruntime: claude-code\n");
    const rt = await makeRuntime();
    addAgent(rt, "alpha", "agent-1", "claude-code");
    await rt.start();

    firePinned("agent-1", "alpha", "claude-code");

    // Allow any (incorrect) async swap to surface before asserting.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(slotInstances).toHaveLength(1);
    expect(slotInstances[0]?.stop).not.toHaveBeenCalled();
    await rt.stop();
  });

  it("stops the agent with a warning when switched to a provider this build lacks", async () => {
    const { print } = await import("../core/output.js");
    const yamlPath = writeAgentYaml("alpha", "agentId: agent-1\nruntime: claude-code\n");
    hasHandlerMock.mockImplementation((type: string) => type === "claude-code");
    const rt = await makeRuntime();
    addAgent(rt, "alpha", "agent-1", "claude-code");
    await rt.start();
    const oldSlot = slotInstances[0];
    if (!oldSlot) throw new Error("initial slot missing");

    firePinned("agent-1", "alpha", "claude-code-tui");

    await vi.waitFor(() => expect(oldSlot.stop).toHaveBeenCalled());
    expect(slotInstances).toHaveLength(1);
    expect(print.status).toHaveBeenCalledWith(
      "⚠️",
      expect.stringContaining('agent "alpha" now uses runtime "claude-code-tui"'),
    );
    // The yaml still records the server's authoritative value so a client
    // upgrade + restart picks the agent up with the right provider.
    expect(readFileSync(yamlPath, "utf8")).toContain("runtime: claude-code-tui");
    await rt.stop();
  });

  it("promotes a previously unsupported agent when re-pinned to a supported provider", async () => {
    const yamlPath = writeAgentYaml("tui-agent", "agentId: agent-tui\nruntime: claude-code-tui\n");
    hasHandlerMock.mockImplementation((type: string) => type === "claude-code");
    const rt = await makeRuntime();
    addAgent(rt, "tui-agent", "agent-tui", "claude-code-tui");
    await rt.start();
    expect(slotInstances).toHaveLength(0); // skipped: no handler for the provider

    firePinned("agent-tui", "tui-agent", "claude-code");

    await vi.waitFor(() => expect(slotInstances).toHaveLength(1));
    const slot = slotInstances[0];
    if (!slot) throw new Error("promoted slot missing");
    expect(slot.name).toBe("tui-agent");
    expect(slot.type).toBe("claude-code");
    await vi.waitFor(() => expect(slot.start).toHaveBeenCalled());
    expect(readFileSync(yamlPath, "utf8")).toContain("runtime: claude-code");
    await rt.stop();
  });

  it("repairs a runtime_provider_mismatch bind rejection from the authoritative pinned list", async () => {
    const reconcile = await import("../core/runtime-provider-reconcile.js");
    vi.mocked(reconcile.listPinnedAgents).mockResolvedValue([
      { agentId: "agent-1", clientId: "client-test", runtimeProvider: "claude-code-tui" },
    ]);
    const yamlPath = writeAgentYaml("alpha", "agentId: agent-1\nruntime: claude-code\n");
    const rt = await makeRuntime();
    addAgent(rt, "alpha", "agent-1", "claude-code");
    await rt.start();
    const oldSlot = slotInstances[0];
    if (!oldSlot) throw new Error("initial slot missing");

    fireBindRejected("runtime_provider_mismatch", "agent-1");

    await vi.waitFor(() => expect(slotInstances).toHaveLength(2));
    const newSlot = slotInstances[1];
    if (!newSlot) throw new Error("repaired slot missing");
    expect(oldSlot.stop).toHaveBeenCalled();
    expect(newSlot.type).toBe("claude-code-tui");
    await vi.waitFor(() => expect(newSlot.start).toHaveBeenCalled());
    expect(readFileSync(yamlPath, "utf8")).toContain("runtime: claude-code-tui");
    await rt.stop();
  });

  it("throttles repeated mismatch repairs for the same agent", async () => {
    const reconcile = await import("../core/runtime-provider-reconcile.js");
    vi.mocked(reconcile.listPinnedAgents).mockResolvedValue([
      { agentId: "agent-1", clientId: "client-test", runtimeProvider: "claude-code-tui" },
    ]);
    writeAgentYaml("alpha", "agentId: agent-1\nruntime: claude-code\n");
    const rt = await makeRuntime();
    addAgent(rt, "alpha", "agent-1", "claude-code");
    await rt.start();

    fireBindRejected("runtime_provider_mismatch", "agent-1");
    fireBindRejected("runtime_provider_mismatch", "agent-1");

    await vi.waitFor(() => expect(slotInstances).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reconcile.listPinnedAgents).toHaveBeenCalledTimes(1);
    await rt.stop();
  });

  it("skips repair when the agent is no longer in the pinned list", async () => {
    const { print } = await import("../core/output.js");
    const reconcile = await import("../core/runtime-provider-reconcile.js");
    vi.mocked(reconcile.listPinnedAgents).mockResolvedValue([]);
    writeAgentYaml("alpha", "agentId: agent-1\nruntime: claude-code\n");
    const rt = await makeRuntime();
    addAgent(rt, "alpha", "agent-1", "claude-code");
    await rt.start();

    fireBindRejected("runtime_provider_mismatch", "agent-1");

    await vi.waitFor(() =>
      expect(print.status).toHaveBeenCalledWith("⚠️", expect.stringContaining("not in this user's pinned-agent list")),
    );
    expect(slotInstances).toHaveLength(1);
    expect(slotInstances[0]?.stop).not.toHaveBeenCalled();
    await rt.stop();
  });

  it("skips repair when the server already agrees with the local provider", async () => {
    const { print } = await import("../core/output.js");
    const reconcile = await import("../core/runtime-provider-reconcile.js");
    vi.mocked(reconcile.listPinnedAgents).mockResolvedValue([
      { agentId: "agent-1", clientId: "client-test", runtimeProvider: "claude-code" },
    ]);
    writeAgentYaml("alpha", "agentId: agent-1\nruntime: claude-code\n");
    const rt = await makeRuntime();
    addAgent(rt, "alpha", "agent-1", "claude-code");
    await rt.start();

    fireBindRejected("runtime_provider_mismatch", "agent-1");

    await vi.waitFor(() =>
      expect(print.status).toHaveBeenCalledWith("⚠️", expect.stringContaining("matching the local config")),
    );
    expect(slotInstances).toHaveLength(1);
    expect(slotInstances[0]?.stop).not.toHaveBeenCalled();
    await rt.stop();
  });

  it("ignores bind rejections that are not runtime_provider_mismatch", async () => {
    const reconcile = await import("../core/runtime-provider-reconcile.js");
    writeAgentYaml("alpha", "agentId: agent-1\nruntime: claude-code\n");
    const rt = await makeRuntime();
    addAgent(rt, "alpha", "agent-1", "claude-code");
    await rt.start();

    fireBindRejected("agent_suspended", "agent-1");

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reconcile.listPinnedAgents).not.toHaveBeenCalled();
    expect(slotInstances).toHaveLength(1);
    await rt.stop();
  });
});
