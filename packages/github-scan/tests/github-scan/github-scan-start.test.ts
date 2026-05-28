import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tempRoots: string[] = [];

function makeHome(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `github-scan-start-${prefix}-`));
  tempRoots.push(dir);
  return dir;
}

describe("runStart", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    while (tempRoots.length) {
      const dir = tempRoots.pop();
      if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to start without an explicit repo scope", async () => {
    const { runStart } = await import("../../src/github-scan/engine/commands/start.js");

    const lines: string[] = [];
    const code = await runStart([], {
      write: (line) => lines.push(line),
    });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("missing required --allow-repo");
  });

  it("passes GITHUB_SCAN_DIR/GITHUB_SCAN_HOME plus the cli entrypoint to launchd", async () => {
    const bootstrapLaunchdJob = vi.fn(() => ({
      label: "com.first-tree.github-scan.runner.test.default",
      domain: "gui/1",
      plistPath: "/tmp/plist",
    }));

    vi.doMock("../../src/github-scan/engine/daemon/launchd.js", () => ({
      supportsLaunchd: () => true,
      bootstrapLaunchdJob,
    }));
    vi.doMock("../../src/github-scan/engine/daemon/identity.js", () => ({
      resolveDaemonIdentity: () => ({ login: "alice", host: "github.com" }),
    }));
    vi.doMock("../../src/github-scan/engine/runtime/config.js", () => ({
      loadGitHubScanDaemonConfig: () => ({ host: "github.com" }),
    }));
    vi.doMock("../../src/github-scan/engine/daemon/claim.js", () => ({
      findServiceLock: () => null,
      isLockStale: () => false,
    }));

    const { runStart } = await import("../../src/github-scan/engine/commands/start.js");

    const lines: string[] = [];
    const code = await runStart(["--allow-repo", "owner/repo"], {
      runnerHome: "/tmp/github-scan-home/runner",
      entrypoint: "/tmp/github-scan/dist/cli.mjs",
      workingDirectory: "/Users/alice/first-tree-website",
      write: (line) => lines.push(line),
    });

    expect(code).toBe(0);
    expect(bootstrapLaunchdJob).toHaveBeenCalledWith(
      expect.objectContaining({
        runnerHome: "/tmp/github-scan-home/runner",
        executable: process.execPath,
        arguments: [
          "/tmp/github-scan/dist/cli.mjs",
          "github",
          "scan",
          "daemon",
          "--backend=ts",
          "--allow-repo",
          "owner/repo",
        ],
        workingDirectory: "/Users/alice/first-tree-website",
        env: {
          GITHUB_SCAN_DIR: "/tmp/github-scan-home",
          GITHUB_SCAN_HOME: "/tmp/github-scan-home/runner",
        },
      }),
    );
    expect(lines).toContain("github-scan-daemon started in background via launchd");
  });

  it("forwards --tree-repo into the daemon argv when the umbrella set FIRST_TREE_GITHUB_SCAN_TREE_REPO (#380 round 2)", async () => {
    const bootstrapLaunchdJob = vi.fn(() => ({
      label: "com.first-tree.github-scan.runner.test.default",
      domain: "gui/1",
      plistPath: "/tmp/plist",
    }));

    vi.doMock("../../src/github-scan/engine/daemon/launchd.js", () => ({
      supportsLaunchd: () => true,
      bootstrapLaunchdJob,
    }));
    vi.doMock("../../src/github-scan/engine/daemon/identity.js", () => ({
      resolveDaemonIdentity: () => ({ login: "alice", host: "github.com" }),
    }));
    vi.doMock("../../src/github-scan/engine/runtime/config.js", () => ({
      loadGitHubScanDaemonConfig: () => ({ host: "github.com" }),
    }));
    vi.doMock("../../src/github-scan/engine/daemon/claim.js", () => ({
      findServiceLock: () => null,
      isLockStale: () => false,
    }));

    const previous = process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO;
    process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO = "owner/tree-repo";

    try {
      const { runStart } = await import("../../src/github-scan/engine/commands/start.js");

      // Simulate `start --tree-repo X --allow-repo Y` run from an
      // UNBOUND dir: the umbrella has already stripped --tree-repo from
      // argv and set the env var. The launchd-spawned daemon doesn't
      // inherit that env var (and the umbrella binding gate re-parses
      // --tree-repo from argv anyway), so we must put --tree-repo back
      // onto the daemon's ProgramArguments.
      const code = await runStart(["--allow-repo", "owner/repo"], {
        runnerHome: "/tmp/github-scan-home/runner",
        entrypoint: "/tmp/github-scan/dist/cli.mjs",
        workingDirectory: "/tmp",
        write: () => {},
      });

      expect(code).toBe(0);
      expect(bootstrapLaunchdJob).toHaveBeenCalledWith(
        expect.objectContaining({
          arguments: [
            "/tmp/github-scan/dist/cli.mjs",
            "github",
            "scan",
            "daemon",
            "--backend=ts",
            "--tree-repo",
            "owner/tree-repo",
            "--allow-repo",
            "owner/repo",
          ],
        }),
      );
    } finally {
      if (previous === undefined) {
        delete process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO;
      } else {
        process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO = previous;
      }
    }
  });

  it("omits --tree-repo from the daemon argv when no binding env var is set (#380 round 2)", async () => {
    const bootstrapLaunchdJob = vi.fn(() => ({
      label: "com.first-tree.github-scan.runner.test.default",
      domain: "gui/1",
      plistPath: "/tmp/plist",
    }));

    vi.doMock("../../src/github-scan/engine/daemon/launchd.js", () => ({
      supportsLaunchd: () => true,
      bootstrapLaunchdJob,
    }));
    vi.doMock("../../src/github-scan/engine/daemon/identity.js", () => ({
      resolveDaemonIdentity: () => ({ login: "alice", host: "github.com" }),
    }));
    vi.doMock("../../src/github-scan/engine/runtime/config.js", () => ({
      loadGitHubScanDaemonConfig: () => ({ host: "github.com" }),
    }));
    vi.doMock("../../src/github-scan/engine/daemon/claim.js", () => ({
      findServiceLock: () => null,
      isLockStale: () => false,
    }));

    const previous = process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO;
    delete process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO;

    try {
      const { runStart } = await import("../../src/github-scan/engine/commands/start.js");

      await runStart(["--allow-repo", "owner/repo"], {
        runnerHome: "/tmp/github-scan-home/runner",
        entrypoint: "/tmp/github-scan/dist/cli.mjs",
        workingDirectory: "/Users/alice/first-tree-website",
        write: () => {},
      });

      const call = bootstrapLaunchdJob.mock.calls[0]?.[0] as { arguments: string[] };
      expect(call.arguments).not.toContain("--tree-repo");
    } finally {
      if (previous !== undefined) {
        process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO = previous;
      }
    }
  });

  it("refuses to start and points to `first-tree github scan stop` when a live daemon is detected (#293)", async () => {
    const bootstrapLaunchdJob = vi.fn();

    vi.doMock("../../src/github-scan/engine/daemon/launchd.js", () => ({
      supportsLaunchd: () => true,
      bootstrapLaunchdJob,
    }));
    vi.doMock("../../src/github-scan/engine/daemon/identity.js", () => ({
      resolveDaemonIdentity: () => ({ login: "alice", host: "github.com" }),
    }));
    vi.doMock("../../src/github-scan/engine/runtime/config.js", () => ({
      loadGitHubScanDaemonConfig: () => ({ host: "github.com" }),
    }));
    vi.doMock("../../src/github-scan/engine/daemon/claim.js", () => ({
      findServiceLock: () => ({
        pid: 97184,
        heartbeat_epoch: Math.floor(Date.now() / 1000),
        active_tasks: 0,
        note: "",
      }),
      isLockStale: () => false,
    }));

    const { runStart } = await import("../../src/github-scan/engine/commands/start.js");

    const lines: string[] = [];
    const code = await runStart(["--allow-repo", "owner/repo"], {
      runnerHome: "/tmp/github-scan-home/runner",
      entrypoint: "/tmp/github-scan/dist/cli.mjs",
      write: (line) => lines.push(line),
    });

    expect(code).toBe(1);
    expect(bootstrapLaunchdJob).not.toHaveBeenCalled();
    const output = lines.join("\n");
    expect(output).toContain("daemon already running (pid 97184)");
    expect(output).toContain("first-tree github scan stop");
  });

  it("includes --home/--profile in the stop hint when the caller set them (#301 review)", async () => {
    vi.doMock("../../src/github-scan/engine/daemon/launchd.js", () => ({
      supportsLaunchd: () => true,
      bootstrapLaunchdJob: vi.fn(),
    }));
    vi.doMock("../../src/github-scan/engine/daemon/identity.js", () => ({
      resolveDaemonIdentity: () => ({ login: "alice", host: "github.com" }),
    }));
    vi.doMock("../../src/github-scan/engine/runtime/config.js", () => ({
      loadGitHubScanDaemonConfig: () => ({ host: "github.com" }),
    }));
    vi.doMock("../../src/github-scan/engine/daemon/claim.js", () => ({
      findServiceLock: () => ({
        pid: 4242,
        heartbeat_epoch: Math.floor(Date.now() / 1000),
        active_tasks: 0,
        note: "",
      }),
      isLockStale: () => false,
    }));

    const { runStart } = await import("../../src/github-scan/engine/commands/start.js");

    const lines: string[] = [];
    const code = await runStart(["--allow-repo", "owner/repo", "--home", "/custom/home", "--profile", "work"], {
      write: (line) => lines.push(line),
    });

    expect(code).toBe(1);
    const output = lines.join("\n");
    expect(output).toContain("first-tree github scan stop --home /custom/home --profile work");
  });

  it("reports daemon identity resolution failures", async () => {
    vi.doMock("../../src/github-scan/engine/daemon/identity.js", () => ({
      resolveDaemonIdentity: () => {
        throw new Error("gh auth status failed");
      },
    }));
    vi.doMock("../../src/github-scan/engine/runtime/config.js", () => ({
      loadGitHubScanDaemonConfig: () => ({ host: "github.example.com" }),
    }));

    const { runStart } = await import("../../src/github-scan/engine/commands/start.js");

    const lines: string[] = [];
    const code = await runStart(["--allow-repo", "owner/repo"], {
      runnerHome: makeHome("identity-failure"),
      write: (line) => lines.push(line),
    });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("gh auth status failed");
  });

  it("falls back to detached spawn when launchd bootstrap fails", async () => {
    const spawn = vi.fn(() => ({
      pid: 2468,
      unref: vi.fn(),
    }));
    const bootstrapLaunchdJob = vi.fn(() => {
      throw new Error("launchctl unavailable");
    });

    vi.doMock("node:child_process", () => ({ spawn }));
    vi.doMock("../../src/github-scan/engine/daemon/launchd.js", () => ({
      supportsLaunchd: () => true,
      bootstrapLaunchdJob,
    }));
    vi.doMock("../../src/github-scan/engine/daemon/identity.js", () => ({
      resolveDaemonIdentity: () => ({ login: "alice", host: "github.com" }),
    }));
    vi.doMock("../../src/github-scan/engine/runtime/config.js", () => ({
      loadGitHubScanDaemonConfig: () => ({ host: "github.com" }),
    }));
    vi.doMock("../../src/github-scan/engine/daemon/claim.js", () => ({
      findServiceLock: () => null,
      isLockStale: () => false,
    }));

    const { runStart } = await import("../../src/github-scan/engine/commands/start.js");

    const lines: string[] = [];
    const code = await runStart(["--allow-repo", "owner/repo"], {
      runnerHome: makeHome("launchd-fallback"),
      executable: "/usr/local/bin/first-tree-dev",
      daemonArgs: ["github", "scan", "daemon", "--backend=ts", "--allow-repo", "owner/repo"],
      write: (line) => lines.push(line),
    });

    expect(code).toBe(0);
    expect(bootstrapLaunchdJob).toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledWith(
      "/usr/local/bin/first-tree-dev",
      ["github", "scan", "daemon", "--backend=ts", "--allow-repo", "owner/repo"],
      expect.objectContaining({
        detached: true,
        stdio: expect.arrayContaining(["ignore"]),
      }),
    );
    expect(lines.join("\n")).toContain("launchd bootstrap failed");
    expect(lines.join("\n")).toContain("github-scan-daemon started via detached spawn");
  });

  it("reports a detached spawn without a pid", async () => {
    const spawn = vi.fn(() => ({
      pid: undefined,
      unref: vi.fn(),
    }));

    vi.doMock("node:child_process", () => ({ spawn }));
    vi.doMock("../../src/github-scan/engine/daemon/launchd.js", () => ({
      supportsLaunchd: () => false,
      bootstrapLaunchdJob: vi.fn(),
    }));
    vi.doMock("../../src/github-scan/engine/daemon/identity.js", () => ({
      resolveDaemonIdentity: () => ({ login: "alice", host: "github.com" }),
    }));
    vi.doMock("../../src/github-scan/engine/runtime/config.js", () => ({
      loadGitHubScanDaemonConfig: () => ({ host: "github.com" }),
    }));
    vi.doMock("../../src/github-scan/engine/daemon/claim.js", () => ({
      findServiceLock: () => null,
      isLockStale: () => false,
    }));

    const { runStart } = await import("../../src/github-scan/engine/commands/start.js");

    const lines: string[] = [];
    const code = await runStart(["--allow-repo", "owner/repo"], {
      runnerHome: makeHome("spawn-no-pid"),
      executable: "/usr/local/bin/first-tree-dev",
      daemonArgs: ["github", "scan", "daemon", "--backend=ts"],
      write: (line) => lines.push(line),
    });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("failed to spawn detached daemon process");
  });

  it("ignores a stale service lock and starts a replacement daemon", async () => {
    const spawn = vi.fn(() => ({
      pid: 8642,
      unref: vi.fn(),
    }));

    vi.doMock("node:child_process", () => ({ spawn }));
    vi.doMock("../../src/github-scan/engine/daemon/launchd.js", () => ({
      supportsLaunchd: () => false,
      bootstrapLaunchdJob: vi.fn(),
    }));
    vi.doMock("../../src/github-scan/engine/daemon/identity.js", () => ({
      resolveDaemonIdentity: () => ({ login: "alice", host: "github.com" }),
    }));
    vi.doMock("../../src/github-scan/engine/runtime/config.js", () => ({
      loadGitHubScanDaemonConfig: () => ({ host: "github.com" }),
    }));
    vi.doMock("../../src/github-scan/engine/daemon/claim.js", () => ({
      findServiceLock: () => ({
        pid: 1357,
        heartbeat_epoch: 1,
        active_tasks: 0,
        note: "old",
      }),
      isLockStale: () => true,
    }));

    const { runStart } = await import("../../src/github-scan/engine/commands/start.js");

    const lines: string[] = [];
    const code = await runStart(["--allow-repo", "owner/repo"], {
      runnerHome: makeHome("stale-lock"),
      executable: "/usr/local/bin/first-tree-dev",
      daemonArgs: ["github", "scan", "daemon", "--backend=ts"],
      write: (line) => lines.push(line),
    });

    expect(code).toBe(0);
    expect(spawn).toHaveBeenCalled();
    expect(lines.join("\n")).toContain("pid: 8642");
  });

  it("quotes stop hints for paths and profiles with shell-sensitive characters", async () => {
    vi.doMock("../../src/github-scan/engine/daemon/launchd.js", () => ({
      supportsLaunchd: () => true,
      bootstrapLaunchdJob: vi.fn(),
    }));
    vi.doMock("../../src/github-scan/engine/daemon/identity.js", () => ({
      resolveDaemonIdentity: () => ({ login: "alice", host: "github.com" }),
    }));
    vi.doMock("../../src/github-scan/engine/runtime/config.js", () => ({
      loadGitHubScanDaemonConfig: () => ({ host: "github.com" }),
    }));
    vi.doMock("../../src/github-scan/engine/daemon/claim.js", () => ({
      findServiceLock: () => ({
        pid: 4242,
        heartbeat_epoch: Math.floor(Date.now() / 1000),
        active_tasks: 0,
        note: "",
      }),
      isLockStale: () => false,
    }));

    const { runStart } = await import("../../src/github-scan/engine/commands/start.js");

    const lines: string[] = [];
    const code = await runStart(
      ["--allow-repo", "owner/repo", "--home=/tmp/scan's home", "--profile", "work profile"],
      {
        write: (line) => lines.push(line),
      },
    );

    expect(code).toBe(1);
    const output = lines.join("\n");
    expect(output).toContain("--home '/tmp/scan'\\''s home'");
    expect(output).toContain("--profile 'work profile'");
  });

  it("builds daemon argv with prefix args, tree repo binding, and filtered local-only flags", async () => {
    const { defaultDaemonArgs, resolveSelfCliInvocation } = await import(
      "../../src/github-scan/engine/commands/start.js"
    );

    expect(resolveSelfCliInvocation("")).toEqual({
      executable: process.execPath,
      prefixArgs: [],
    });
    expect(
      defaultDaemonArgs(
        [
          "--home",
          "/runner",
          "--profile=work",
          "",
          "--allow-repo",
          "owner/repo",
          "--home=/ignored",
          "--profile",
          "ignored",
        ],
        ["/tmp/first-tree/dist/index.js"],
        { FIRST_TREE_GITHUB_SCAN_TREE_REPO: "owner/tree" },
      ),
    ).toEqual([
      "/tmp/first-tree/dist/index.js",
      "github",
      "scan",
      "daemon",
      "--backend=ts",
      "--tree-repo",
      "owner/tree",
      "--allow-repo",
      "owner/repo",
    ]);
  });
});
