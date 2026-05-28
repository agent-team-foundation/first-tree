import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type Logger = {
  info: (line: string) => void;
  warn: (line: string) => void;
  error: (line: string) => void;
};

type MockState = {
  root: string;
  configThrows?: Error;
  lockThrows?: Error;
  httpThrows?: Error;
  pollerThrows?: Error;
  pollOnceThrows?: Error;
  dispatcherStopThrows?: Error;
  brokerStopThrows?: Error;
  httpDoneRejects?: Error;
  lockReleaseThrows?: Error;
  candidateOutcome: {
    warnings: string[];
    rateLimited: boolean;
    submitted: number;
  };
  calls: string[];
};

let state: MockState;

function makeLogger(lines: string[]): Logger {
  return {
    info: (line) => lines.push(`INFO ${line}`),
    warn: (line) => lines.push(`WARN ${line}`),
    error: (line) => lines.push(`ERROR ${line}`),
  };
}

function createState(overrides: Partial<MockState> = {}): MockState {
  return {
    root: mkdtempSync(join(tmpdir(), "github-scan-runner-branches-")),
    candidateOutcome: { warnings: ["candidate warning"], rateLimited: true, submitted: 2 },
    calls: [],
    ...overrides,
  };
}

function installRunnerMocks(nextState: MockState): void {
  state = nextState;

  vi.doMock("node:child_process", () => ({
    execSync: (command: string) => {
      state.calls.push(`exec:${command}`);
      if (command.includes("gh")) return "/usr/bin/gh\n";
      return "";
    },
  }));

  vi.doMock("../../src/github-scan/engine/runtime/allow-repo.js", () => ({
    requireExplicitRepoFilter: (allowRepo: string | undefined) => {
      if (!allowRepo) throw new Error("missing required --allow-repo");
      return {
        isEmpty: () => false,
        displayPatterns: () => allowRepo,
      };
    },
  }));

  vi.doMock("../../src/github-scan/engine/runtime/config.js", () => ({
    loadGitHubScanDaemonConfig: ({ cliOverrides }: { cliOverrides?: Record<string, unknown> }) => {
      if (state.configThrows) throw state.configThrows;
      return {
        host: "github.com",
        pollIntervalSec: Number(cliOverrides?.pollIntervalSec ?? 1),
        httpPort: 8181,
        taskTimeoutSec: 5,
        maxParallel: 2,
        searchLimit: 7,
        agentLogin: cliOverrides?.agentLogin,
        treeRepo: "owner/context-tree",
      };
    },
  }));

  vi.doMock("../../src/github-scan/engine/runtime/paths.js", () => ({
    resolveGitHubScanPaths: () => ({
      root: state.root,
      inbox: join(state.root, "inbox.json"),
      activityLog: join(state.root, "activity.log"),
      claimsDir: join(state.root, "claims"),
      identityCache: join(state.root, "identity.json"),
      inboxLock: join(state.root, "inbox.json.lock"),
    }),
  }));

  vi.doMock("../../src/github-scan/engine/runtime/gh.js", () => ({
    GhClient: class CoreGhClient {},
  }));

  vi.doMock("../../src/github-scan/engine/daemon/agent-templates.js", () => ({
    loadAgentTemplateSpecs: () => [{ kind: "codex", templateName: "developer", prompt: "Review GitHub work." }],
  }));

  vi.doMock("../../src/github-scan/engine/daemon/broker.js", () => ({
    startGhBroker: async () => {
      state.calls.push("startGhBroker");
      return {
        shimDir: join(state.root, "broker", "shim"),
        brokerDir: join(state.root, "broker"),
        stop: async () => {
          state.calls.push("broker.stop");
          if (state.brokerStopThrows) throw state.brokerStopThrows;
        },
      };
    },
  }));

  vi.doMock("../../src/github-scan/engine/daemon/bus.js", () => ({
    createBus: () => ({
      publish: (event: unknown) => state.calls.push(`bus.publish:${JSON.stringify(event)}`),
      close: () => state.calls.push("bus.close"),
    }),
    toSseBus: (bus: unknown) => bus,
  }));

  vi.doMock("../../src/github-scan/engine/daemon/candidate-loop.js", () => ({
    runCandidateCycle: async () => {
      state.calls.push("runCandidateCycle");
      return state.candidateOutcome;
    },
    runCandidateLoop: () => {
      state.calls.push("runCandidateLoop");
      return Promise.resolve();
    },
  }));

  vi.doMock("../../src/github-scan/engine/daemon/claim.js", () => ({
    acquireServiceLock: async () => {
      state.calls.push("acquireServiceLock");
      if (state.lockThrows) throw state.lockThrows;
      return {
        refresh: (active: number, note: string) => state.calls.push(`lock.refresh:${active}:${note}`),
        release: async () => {
          state.calls.push("lock.release");
          if (state.lockReleaseThrows) throw state.lockReleaseThrows;
        },
      };
    },
  }));

  vi.doMock("../../src/github-scan/engine/daemon/dispatcher.js", () => ({
    Dispatcher: class Dispatcher {
      activeCount(): number {
        return 0;
      }
      pendingCount(): number {
        return 0;
      }
      async stop(): Promise<void> {
        state.calls.push("dispatcher.stop");
        if (state.dispatcherStopThrows) throw state.dispatcherStopThrows;
      }
    },
  }));

  vi.doMock("../../src/github-scan/engine/daemon/gh-client.js", () => ({
    GhClient: class BrokerGhClient {},
  }));

  vi.doMock("../../src/github-scan/engine/daemon/gh-executor.js", () => ({
    GhExecutor: class GhExecutor {
      constructor() {
        state.calls.push("GhExecutor");
      }
    },
  }));

  vi.doMock("../../src/github-scan/engine/daemon/http.js", () => ({
    startHttpServer: async () => {
      state.calls.push("startHttpServer");
      if (state.httpThrows) throw state.httpThrows;
      return {
        port: 8181,
        done: state.httpDoneRejects ? Promise.reject(state.httpDoneRejects) : Promise.resolve(),
        stop: async () => state.calls.push("http.stop"),
      };
    },
  }));

  vi.doMock("../../src/github-scan/engine/daemon/identity.js", () => ({
    identityHasRequiredScope: () => false,
    resolveDaemonIdentity: () => ({
      host: "github.com",
      login: "tester",
      gitProtocol: "https",
      scopes: ["repo"],
    }),
  }));

  vi.doMock("../../src/github-scan/engine/daemon/poller.js", () => ({
    pollOnce: async () => {
      state.calls.push("pollOnce");
      if (state.pollOnceThrows) throw state.pollOnceThrows;
      return { warnings: ["poll warning"], total: 3, newCount: 1 };
    },
    runPoller: async () => {
      state.calls.push("runPoller");
      if (state.pollerThrows) throw state.pollerThrows;
    },
  }));

  vi.doMock("../../src/github-scan/engine/daemon/runner.js", () => ({
    formatAgentSpecLabel: (agent: { kind: string; templateName?: string }) =>
      agent.templateName ? `${agent.kind}:${agent.templateName}` : agent.kind,
  }));

  vi.doMock("../../src/github-scan/engine/daemon/scheduler.js", () => ({
    Scheduler: class Scheduler {
      handleCompletion(): void {
        state.calls.push("scheduler.handleCompletion");
      }
      enqueueRecoverableTasks(host: string): unknown[] {
        state.calls.push(`scheduler.enqueueRecoverableTasks:${host}`);
        return [];
      }
    },
  }));

  vi.doMock("../../src/github-scan/engine/daemon/thread-store.js", () => ({
    ThreadStore: class ThreadStore {
      writeRuntimeStatus(status: Record<string, string>): void {
        state.calls.push(`runtime:${status.last_note}:${status.last_identity}`);
      }
      listDashboardTasks(): unknown[] {
        return [];
      }
    },
  }));

  vi.doMock("../../src/github-scan/engine/daemon/workspace.js", () => ({
    WorkspaceManager: class WorkspaceManager {},
  }));
}

describe("runDaemon mocked dependency branches", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    if (state?.root) rmSync(state.root, { recursive: true, force: true });
  });

  it("runs one-shot poller and candidate cycle with dispatcher/broker wiring", async () => {
    const lines: string[] = [];
    installRunnerMocks(createState());

    const { runDaemon } = await import("../../src/github-scan/engine/daemon/runner-skeleton.js");
    const code = await runDaemon([], {
      cliOverrides: { allowRepo: "owner/repo", pollIntervalSec: 1, agentLogin: "override-bot" },
      installSignalHandlers: false,
      once: true,
      logger: makeLogger(lines),
    });

    expect(code).toBe(0);
    expect(state.calls).toEqual(expect.arrayContaining(["startGhBroker", "runCandidateCycle", "pollOnce"]));
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("lacks `repo`/`notifications` scope"),
        expect.stringContaining("agent-login overridden to 'override-bot'"),
        expect.stringContaining("dispatcher ready (agents=codex:developer"),
        expect.stringContaining("poll warning"),
        expect.stringContaining("candidate search rate-limited"),
        expect.stringContaining("candidates: submitted 2 task(s)"),
        expect.stringContaining("shutdown complete"),
      ]),
    );
    expect(state.calls.some((call) => call.includes("bus.publish"))).toBe(true);
  });

  it("returns 1 when config loading fails before daemon startup", async () => {
    const lines: string[] = [];
    installRunnerMocks(createState({ configThrows: new Error("bad config") }));

    const { runDaemon } = await import("../../src/github-scan/engine/daemon/runner-skeleton.js");
    const code = await runDaemon([], {
      cliOverrides: { allowRepo: "owner/repo" },
      installSignalHandlers: false,
      logger: makeLogger(lines),
    });

    expect(code).toBe(1);
    expect(lines).toContain("ERROR failed to load daemon config: bad config");
  });

  it("returns 1 when the singleton service lock refuses startup", async () => {
    const lines: string[] = [];
    installRunnerMocks(createState({ lockThrows: new Error("already running") }));

    const { runDaemon } = await import("../../src/github-scan/engine/daemon/runner-skeleton.js");
    const code = await runDaemon([], {
      cliOverrides: { allowRepo: "owner/repo" },
      installSignalHandlers: false,
      logger: makeLogger(lines),
    });

    expect(code).toBe(1);
    expect(lines).toContain("ERROR github-scan daemon: refusing to start — already running");
  });

  it("cleans up dispatcher, broker, handlers, and lock when HTTP startup fails", async () => {
    const lines: string[] = [];
    installRunnerMocks(createState({ httpThrows: new Error("port busy") }));

    const { runDaemon } = await import("../../src/github-scan/engine/daemon/runner-skeleton.js");
    const code = await runDaemon([], {
      cliOverrides: { allowRepo: "owner/repo" },
      installSignalHandlers: false,
      logger: makeLogger(lines),
    });

    expect(code).toBe(1);
    expect(lines).toContain("ERROR failed to start http server: port busy");
    expect(state.calls).toEqual(expect.arrayContaining(["dispatcher.stop", "broker.stop", "lock.release"]));
  });

  it("reports poller failures and shutdown cleanup warnings", async () => {
    const lines: string[] = [];
    installRunnerMocks(
      createState({
        pollerThrows: new Error("poll exploded"),
        dispatcherStopThrows: new Error("dispatcher stuck"),
        brokerStopThrows: new Error("broker stuck"),
        httpDoneRejects: new Error("http stuck"),
        lockReleaseThrows: new Error("lock stuck"),
      }),
    );

    const { runDaemon } = await import("../../src/github-scan/engine/daemon/runner-skeleton.js");
    const code = await runDaemon([], {
      cliOverrides: { allowRepo: "owner/repo" },
      installSignalHandlers: false,
      logger: makeLogger(lines),
    });

    expect(code).toBe(1);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("poller exited with error: Error: poll exploded"),
        "WARN dispatcher shutdown failed: dispatcher stuck",
        "WARN broker shutdown failed: broker stuck",
        "WARN http server shutdown failed: http stuck",
        "WARN service lock release failed: lock stuck",
      ]),
    );
  });
});
