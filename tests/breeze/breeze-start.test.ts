import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("runStart", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("refuses to start without an explicit repo scope", async () => {
    const { runStart } = await import(
      "../../src/products/breeze/engine/commands/start.js"
    );

    const lines: string[] = [];
    const code = await runStart([], {
      write: (line) => lines.push(line),
    });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("missing required --allow-repo");
  });

  it("passes BREEZE_DIR/BREEZE_HOME plus the cli entrypoint to launchd", async () => {
    const bootstrapLaunchdJob = vi.fn(() => ({
      label: "com.breeze.runner.test.default",
      domain: "gui/1",
      plistPath: "/tmp/plist",
    }));

    vi.doMock("../../src/products/breeze/engine/daemon/launchd.js", () => ({
      supportsLaunchd: () => true,
      bootstrapLaunchdJob,
    }));
    vi.doMock("../../src/products/breeze/engine/daemon/identity.js", () => ({
      resolveDaemonIdentity: () => ({ login: "alice", host: "github.com" }),
    }));
    vi.doMock("../../src/products/breeze/engine/runtime/config.js", () => ({
      loadBreezeDaemonConfig: () => ({ host: "github.com" }),
    }));

    const { runStart } = await import(
      "../../src/products/breeze/engine/commands/start.js"
    );

    const lines: string[] = [];
    const code = await runStart(["--allow-repo", "owner/repo"], {
      runnerHome: "/tmp/breeze-home/runner",
      entrypoint: "/tmp/first-tree/dist/cli.js",
      write: (line) => lines.push(line),
    });

    expect(code).toBe(0);
    expect(bootstrapLaunchdJob).toHaveBeenCalledWith(
      expect.objectContaining({
        runnerHome: "/tmp/breeze-home/runner",
        executable: process.execPath,
        arguments: [
          "/tmp/first-tree/dist/cli.js",
          "breeze",
          "daemon",
          "--backend=ts",
          "--allow-repo",
          "owner/repo",
        ],
        env: {
          BREEZE_DIR: "/tmp/breeze-home",
          BREEZE_HOME: "/tmp/breeze-home/runner",
        },
      }),
    );
    expect(lines).toContain("breeze-daemon started in background via launchd");
  });
});
