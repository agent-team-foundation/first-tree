import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FirstTreeHubSDK } from "../sdk.js";

type ExecCall = {
  command: string;
  args: string[];
  options?: Record<string, unknown>;
};

type MockState = {
  gitAvailable: boolean;
  gitExists: boolean;
  currentBranch: string;
  config: { repo: string | null; branch?: string | null };
  configError?: unknown;
  pullError?: unknown;
  cloneOutcomes: unknown[];
  calls: ExecCall[];
  logs: string[];
  mkdirs: string[];
  rms: string[];
  rewriteMismatch: boolean;
  statError?: unknown;
  statIsFile: boolean;
};

function installContextSyncMocks(overrides: Partial<MockState> = {}): MockState {
  vi.resetModules();
  const state: MockState = {
    gitAvailable: true,
    gitExists: false,
    currentBranch: "main",
    config: { repo: "https://github.com/example/tree.git", branch: "main" },
    cloneOutcomes: [],
    calls: [],
    logs: [],
    mkdirs: [],
    rms: [],
    rewriteMismatch: false,
    statIsFile: true,
    ...overrides,
  };

  // Shared git mock body — both the sync and async exec paths route through
  // this so test expectations on `state.calls` stay agnostic to which one
  // production code chose to call. The async wrapper exposes the Node
  // callback shape (`(err, stdout, stderr)`) that `util.promisify(execFile)`
  // requires.
  const runGit = (command: string, args: string[], options?: Record<string, unknown>): string => {
    state.calls.push({ command, args, options });
    if (command !== "git") throw new Error(`unexpected command ${command}`);
    const subcommand = args[0];
    if (subcommand === "--version") {
      if (!state.gitAvailable) throw new Error("git missing");
      return "git version 2.0.0\n";
    }
    if (subcommand === "rev-parse") {
      return `${state.currentBranch}\n`;
    }
    if (subcommand === "checkout") {
      state.currentBranch = args[1] ?? state.currentBranch;
      return "";
    }
    if (subcommand === "pull") {
      if (state.pullError !== undefined) throw state.pullError;
      return "";
    }
    if (subcommand === "clone") {
      const outcome = state.cloneOutcomes.shift();
      if (outcome !== undefined) throw outcome;
      state.gitExists = true;
      return "";
    }
    throw new Error(`unexpected git subcommand ${String(subcommand)}`);
  };

  // util.promisify(execFile) reads the `[util.promisify.custom]` symbol off
  // the real Node implementation and returns its async form (resolves to
  // `{ stdout, stderr }`). Replicate the same shape on the mock so production
  // code that does `promisify(execFile)` at module-load time gets a working
  // promise wrapper that routes through `runGit`.
  const execFileMock = vi.fn(
    (
      command: string,
      args: string[],
      optionsOrCallback?: Record<string, unknown> | ((err: Error | null, stdout?: string, stderr?: string) => void),
      maybeCallback?: (err: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;
      const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
      try {
        const stdout = runGit(command, args, options);
        callback?.(null, stdout, "");
      } catch (err) {
        callback?.(err as Error);
      }
    },
  );
  Object.defineProperty(execFileMock, promisify.custom, {
    value: (command: string, args: string[], options?: Record<string, unknown>) =>
      new Promise<{ stdout: string; stderr: string }>((resolveExec, rejectExec) => {
        try {
          const stdout = runGit(command, args, options);
          resolveExec({ stdout, stderr: "" });
        } catch (err) {
          rejectExec(err);
        }
      }),
  });

  vi.doMock("node:child_process", () => ({
    execFileSync: vi.fn(runGit),
    execFile: execFileMock,
  }));
  vi.doMock("node:fs", () => ({
    copyFileSync: vi.fn(),
    existsSync: vi.fn((path: string) => {
      if (path.endsWith("/.git")) return state.gitExists;
      return false;
    }),
    mkdirSync: vi.fn((path: string) => {
      state.mkdirs.push(path);
    }),
    readFileSync: vi.fn(),
    rmSync: vi.fn((path: string) => {
      state.rms.push(path);
      state.gitExists = false;
    }),
    statSync: vi.fn(() => {
      if (state.statError !== undefined) throw state.statError;
      return { isFile: () => state.statIsFile };
    }),
    writeFileSync: vi.fn(),
  }));
  vi.doMock("@first-tree/shared/config", () => ({
    defaultDataDir: () => "/tmp/first-tree-data",
  }));
  // Spread the real module so bootstrap's permission-shape classifier helpers
  // (`isLikelyRepoNotFound` / `isLikely*AuthFailure`) keep their production
  // behavior — only the SSH-rewrite table is stubbed for URL control.
  vi.doMock("../runtime/git-mirror-manager.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../runtime/git-mirror-manager.js")>();
    return {
      ...actual,
      httpsToSshBaseRewrite: vi.fn((url: string) => {
        if (!url.startsWith("https://github.com/")) return null;
        return state.rewriteMismatch
          ? { httpsBase: "https://gitlab.com/", sshBase: "git@gitlab.com:" }
          : { httpsBase: "https://github.com/", sshBase: "git@github.com:" };
      }),
    };
  });
  vi.doMock("../sdk.js", () => ({
    FirstTreeHubSDK: class {
      serverUrl: string;
      userAgent: string | undefined;

      constructor(options: { serverUrl: string; userAgent?: string }) {
        this.serverUrl = options.serverUrl;
        this.userAgent = options.userAgent;
      }

      async getContextTreeConfig(): Promise<MockState["config"]> {
        if (state.configError !== undefined) throw state.configError;
        return state.config;
      }
    },
  }));

  return state;
}

describe("Context Tree sync bootstrap paths", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("node:child_process");
    vi.doUnmock("node:fs");
    vi.doUnmock("@first-tree/shared/config");
    vi.doUnmock("../runtime/git-mirror-manager.js");
    vi.doUnmock("../sdk.js");
    vi.resetModules();
  });

  it("syncContextTree skips when git is unavailable", async () => {
    const state = installContextSyncMocks({ gitAvailable: false });
    const { syncContextTree } = await import("../runtime/bootstrap.js");

    await expect(
      syncContextTree(
        "https://first-tree.example",
        async () => "token",
        (msg) => state.logs.push(msg),
      ),
    ).resolves.toBeNull();

    expect(state.logs).toContain("Context Tree sync skipped: git is not installed");
  });

  it("syncAgentContextTree skips when the agent has no configured tree and stringifies fetch failures", async () => {
    const state = installContextSyncMocks({ config: { repo: null, branch: null } });
    const { syncAgentContextTree } = await import("../runtime/bootstrap.js");
    const sdk = {
      getAgentContextTreeConfig: vi.fn(async () => state.config),
    };

    // syncAgentContextTree only needs this one SDK method for the binding fetch.
    await expect(
      syncAgentContextTree(sdk as unknown as FirstTreeHubSDK, (msg) => state.logs.push(msg)),
    ).resolves.toBeNull();
    expect(state.logs).toContain("Context Tree sync skipped: not configured on server");

    state.logs = [];
    sdk.getAgentContextTreeConfig.mockRejectedValueOnce("config service down");
    await expect(
      syncAgentContextTree(sdk as unknown as FirstTreeHubSDK, (msg) => state.logs.push(msg)),
    ).resolves.toBeNull();
    expect(state.logs).toContain("Context Tree sync skipped: failed to fetch config from server (config service down)");
  });

  it("logs Error fetch failures while resolving the agent tree binding", async () => {
    const state = installContextSyncMocks();
    const { syncAgentContextTree } = await import("../runtime/bootstrap.js");
    const sdk = {
      getAgentContextTreeConfig: vi.fn().mockRejectedValue(new Error("config exploded")),
    };

    await expect(
      syncAgentContextTree(sdk as unknown as FirstTreeHubSDK, (msg) => state.logs.push(msg)),
    ).resolves.toBeNull();

    expect(state.logs).toContain("Context Tree sync skipped: failed to fetch config from server (config exploded)");
  });

  it("clones a new tree checkout and defaults a missing branch to main", async () => {
    const state = installContextSyncMocks({ config: { repo: "https://github.com/example/tree.git", branch: null } });
    const { syncContextTree } = await import("../runtime/bootstrap.js");

    const binding = await syncContextTree(
      "https://first-tree.example",
      async () => "token",
      (msg) => state.logs.push(msg),
      "ua-test",
    );

    expect(binding).toMatchObject({
      repoUrl: "https://github.com/example/tree.git",
      branch: "main",
    });
    expect(binding?.path).toContain("/tmp/first-tree-data/context-tree-repos/");
    expect(state.calls.some((call) => call.args.slice(0, 4).join(" ") === "clone --branch main --single-branch")).toBe(
      true,
    );
    expect(state.logs).toContain("Context Tree cloned from https://github.com/example/tree.git (branch: main)");
  });

  it("pulls an existing checkout and switches branches when needed", async () => {
    const state = installContextSyncMocks({ gitExists: true, currentBranch: "dev" });
    const { syncContextTree } = await import("../runtime/bootstrap.js");

    const binding = await syncContextTree(
      "https://first-tree.example",
      async () => "token",
      (msg) => state.logs.push(msg),
    );

    expect(binding).toMatchObject({ repoUrl: "https://github.com/example/tree.git", branch: "main" });
    expect(state.calls.some((call) => call.args[0] === "checkout" && call.args[1] === "main")).toBe(true);
    expect(state.calls.some((call) => call.args[0] === "pull")).toBe(true);
    expect(state.logs).toContain("Context Tree switched to branch main");
    expect(state.logs).toContain("Context Tree updated (pull)");
  });

  it("pulls an existing checkout without checkout when already on the target branch", async () => {
    const state = installContextSyncMocks({ gitExists: true, currentBranch: "main" });
    const { syncContextTree } = await import("../runtime/bootstrap.js");

    await expect(
      syncContextTree(
        "https://first-tree.example",
        async () => "token",
        (msg) => state.logs.push(msg),
      ),
    ).resolves.toMatchObject({
      branch: "main",
    });

    expect(state.calls.some((call) => call.args[0] === "checkout")).toBe(false);
    expect(state.logs).toContain("Context Tree updated (pull)");
  });

  it("retries a first HTTPS clone via SSH fallback", async () => {
    const state = installContextSyncMocks({
      cloneOutcomes: [new Error("could not read Username")],
    });
    const { syncContextTree } = await import("../runtime/bootstrap.js");

    const binding = await syncContextTree(
      "https://first-tree.example",
      async () => "token",
      (msg) => state.logs.push(msg),
    );

    expect(binding).toMatchObject({ repoUrl: "git@github.com:example/tree.git", branch: "main" });
    expect(state.rms).toHaveLength(1);
    expect(state.calls.some((call) => call.args.includes("git@github.com:example/tree.git"))).toBe(true);
    expect(state.logs).toContain("Retrying Context Tree clone via SSH: git@github.com:example/tree.git");
    expect(state.logs).toContain("Context Tree cloned via SSH fallback");
  });

  it("returns null when a new clone and SSH fallback both fail", async () => {
    const state = installContextSyncMocks({
      cloneOutcomes: [new Error("https failed"), "ssh failed"],
    });
    const { syncContextTree } = await import("../runtime/bootstrap.js");

    await expect(
      syncContextTree(
        "https://first-tree.example",
        async () => "token",
        (msg) => state.logs.push(msg),
      ),
    ).resolves.toBeNull();

    expect(state.logs).toContain("Context Tree SSH fallback also failed: ssh failed");
  });

  it("logs Error objects from a failed SSH fallback", async () => {
    const state = installContextSyncMocks({
      cloneOutcomes: [new Error("https failed"), new Error("ssh error object")],
    });
    const { syncContextTree } = await import("../runtime/bootstrap.js");

    await expect(
      syncContextTree(
        "https://first-tree.example",
        async () => "token",
        (msg) => state.logs.push(msg),
      ),
    ).resolves.toBeNull();

    expect(state.logs).toContain("Context Tree SSH fallback also failed: ssh error object");
  });

  it("returns null when clone fails for a URL that cannot be rewritten to SSH", async () => {
    const state = installContextSyncMocks({
      config: { repo: "git@example.com:org/tree.git", branch: "main" },
      cloneOutcomes: [new Error("clone failed")],
    });
    const { syncContextTree } = await import("../runtime/bootstrap.js");

    await expect(
      syncContextTree(
        "https://first-tree.example",
        async () => "token",
        (msg) => state.logs.push(msg),
      ),
    ).resolves.toBeNull();

    expect(state.logs.some((msg) => msg.includes("Retrying Context Tree clone via SSH"))).toBe(false);
  });

  it("does not retry when the HTTPS rewrite base does not match the repo URL", async () => {
    const state = installContextSyncMocks({
      cloneOutcomes: [new Error("clone failed")],
      rewriteMismatch: true,
    });
    const { syncContextTree } = await import("../runtime/bootstrap.js");

    await expect(
      syncContextTree(
        "https://first-tree.example",
        async () => "token",
        (msg) => state.logs.push(msg),
      ),
    ).resolves.toBeNull();

    expect(state.logs.some((msg) => msg.includes("Retrying Context Tree clone via SSH"))).toBe(false);
  });

  it("re-clones an existing checkout after a diverged pull", async () => {
    const state = installContextSyncMocks({
      gitExists: true,
      pullError: new Error("cannot fast-forward"),
    });
    const { syncContextTree } = await import("../runtime/bootstrap.js");

    await expect(
      syncContextTree(
        "https://first-tree.example",
        async () => "token",
        (msg) => state.logs.push(msg),
      ),
    ).resolves.toMatchObject({
      repoUrl: "https://github.com/example/tree.git",
    });

    expect(state.rms).toHaveLength(1);
    expect(state.logs).toContain("Diverged history detected, attempting fresh clone...");
    expect(state.logs).toContain("Context Tree re-cloned successfully");
  });

  it("returns null when re-clone after divergence fails", async () => {
    const state = installContextSyncMocks({
      gitExists: true,
      pullError: new Error("CONFLICT while pulling"),
      cloneOutcomes: [new Error("clone still failed")],
    });
    const { syncContextTree } = await import("../runtime/bootstrap.js");

    await expect(
      syncContextTree(
        "https://first-tree.example",
        async () => "token",
        (msg) => state.logs.push(msg),
      ),
    ).resolves.toBeNull();

    expect(state.logs).toContain("Context Tree re-clone also failed, continuing without context");
  });

  it("preserves an existing checkout after a transient pull failure", async () => {
    const state = installContextSyncMocks({
      gitExists: true,
      pullError: "network timeout",
    });
    const { syncContextTree } = await import("../runtime/bootstrap.js");

    await expect(
      syncContextTree(
        "https://first-tree.example",
        async () => "token",
        (msg) => state.logs.push(msg),
      ),
    ).resolves.toMatchObject({
      repoUrl: "https://github.com/example/tree.git",
    });

    expect(state.logs).toContain("Context Tree sync failed: network timeout");
    expect(state.logs).toContain("Using existing Context Tree clone despite sync failure");
  });

  it("detects First Tree worktree markers and handles stat failures", async () => {
    const state = installContextSyncMocks({ gitExists: false });
    const { isHubWorktreeMarker } = await import("../runtime/bootstrap.js");

    expect(isHubWorktreeMarker("/workspace")).toBe(false);

    state.gitExists = true;
    state.statIsFile = true;
    expect(isHubWorktreeMarker("/workspace")).toBe(true);

    state.statIsFile = false;
    expect(isHubWorktreeMarker("/workspace")).toBe(false);

    state.statError = new Error("stat failed");
    expect(isHubWorktreeMarker("/workspace")).toBe(false);
  });
});
