import { describe, expect, it } from "vitest";
import {
  assertProviderDrainClear,
  buildChildrenIndex,
  extractChatId,
  extractEnvValue,
  findProviderPids,
  hasDescendant,
  OsProviderDrainSource,
  PsSubprocessProbe,
  parseProcessRows,
  providerNameForComm,
} from "../runtime/process-tree-probe.js";
import { silentLogger } from "./_logger-helpers.js";

describe("process-tree-probe pure helpers", () => {
  it("parses ps pid/ppid/comm rows and skips unparseable lines", () => {
    const out = ["  100   55 /opt/homebrew/bin/claude", " 101  100 /bin/zsh", "garbage", "", "102 101 sleep"].join(
      "\n",
    );
    expect(parseProcessRows(out)).toEqual([
      { pid: 100, ppid: 55, comm: "/opt/homebrew/bin/claude" },
      { pid: 101, ppid: 100, comm: "/bin/zsh" },
      { pid: 102, ppid: 101, comm: "sleep" },
    ]);
  });

  it("finds claude providers that are direct children of the daemon (macOS path + linux basename)", () => {
    const rows = [
      { pid: 100, ppid: 55, comm: "/opt/homebrew/bin/claude" },
      { pid: 200, ppid: 55, comm: "claude" },
      { pid: 300, ppid: 55, comm: "/usr/bin/codex" },
      { pid: 400, ppid: 99, comm: "claude" }, // not a direct child of the daemon
    ];
    expect(findProviderPids(rows, 55).sort((a, b) => a - b)).toEqual([100, 200]);
  });

  it("detects a live descendant via a direct child, and its absence", () => {
    const idx = buildChildrenIndex([
      { pid: 101, ppid: 100, comm: "/bin/zsh" },
      { pid: 102, ppid: 101, comm: "sleep" },
    ]);
    expect(hasDescendant(100, idx)).toBe(true);
    expect(hasDescendant(999, idx)).toBe(false);
  });

  it("extracts FIRST_TREE_CHAT_ID from a Darwin `ps -E` (space-separated) line", () => {
    const line = "FIRST_TREE_HOME=/x FIRST_TREE_CHAT_ID=f93566d9-00c8 FIRST_TREE_AGENT_ID=019e /bin/claude";
    expect(extractChatId(line)).toBe("f93566d9-00c8");
    expect(extractChatId("no marker here")).toBeNull();
  });

  it("extracts FIRST_TREE_CHAT_ID from Linux `/proc/<pid>/environ` (NUL-separated), stopping at the NUL", () => {
    const environ = ["FIRST_TREE_HOME=/x", "FIRST_TREE_CHAT_ID=f93566d9-00c8", "FIRST_TREE_AGENT_ID=019e", ""].join(
      "\0",
    );
    // The value must not bleed into the next NUL-separated entry.
    expect(extractChatId(environ)).toBe("f93566d9-00c8");
  });

  it("extracts arbitrary FIRST_TREE env values and provider names", () => {
    const environ = ["FIRST_TREE_CLIENT_ID=client_a", "FIRST_TREE_HOME=/tmp/first-tree", ""].join("\0");
    expect(extractEnvValue(environ, "FIRST_TREE_CLIENT_ID")).toBe("client_a");
    expect(extractEnvValue(environ, "FIRST_TREE_HOME")).toBe("/tmp/first-tree");
    expect(providerNameForComm("/opt/homebrew/bin/codex")).toBe("codex");
    expect(providerNameForComm("/opt/homebrew/bin/claude")).toBe("claude");
    expect(providerNameForComm("/bin/zsh")).toBeNull();
  });
});

describe("PsSubprocessProbe", () => {
  const daemonPid = 55;
  // chat-A provider (100) has a live watcher; chat-B provider (200) has none.
  const snapshot = [
    `100  ${daemonPid} /opt/homebrew/bin/claude`,
    "101  100 /bin/zsh",
    "102  101 sleep",
    `200  ${daemonPid} /opt/homebrew/bin/claude`,
  ].join("\n");
  const envForPid = async (pid: number): Promise<string> =>
    pid === 100 ? "FIRST_TREE_CHAT_ID=chat-A /bin/claude" : "FIRST_TREE_CHAT_ID=chat-B /bin/claude";

  it("marks only providers that currently have a live descendant", async () => {
    const probe = new PsSubprocessProbe({
      log: silentLogger(),
      daemonPid,
      intervalMs: 1_000_000,
      runProcessSnapshot: async () => snapshot,
      runEnvForPid: envForPid,
    });
    await probe.refresh();
    expect(probe.hasLiveSubprocess("chat-A")).toBe(true);
    expect(probe.hasLiveSubprocess("chat-B")).toBe(false);
    expect(probe.hasLiveSubprocess("chat-unknown")).toBe(false);
    probe.stop();
  });

  it("attributes providers from NUL-separated env (Linux /proc form)", async () => {
    const probe = new PsSubprocessProbe({
      log: silentLogger(),
      daemonPid,
      intervalMs: 1_000_000,
      runProcessSnapshot: async () => snapshot,
      runEnvForPid: async (pid) =>
        ["FIRST_TREE_HOME=/x", `FIRST_TREE_CHAT_ID=${pid === 100 ? "chat-A" : "chat-B"}`, ""].join("\0"),
    });
    await probe.refresh();
    expect(probe.hasLiveSubprocess("chat-A")).toBe(true);
    expect(probe.hasLiveSubprocess("chat-B")).toBe(false);
    probe.stop();
  });

  it("falls back to no-live-work when the process scan fails", async () => {
    const probe = new PsSubprocessProbe({
      log: silentLogger(),
      daemonPid,
      intervalMs: 1_000_000,
      runProcessSnapshot: async () => {
        throw new Error("ps unavailable");
      },
      runEnvForPid: envForPid,
    });
    await probe.refresh();
    expect(probe.hasLiveSubprocess("chat-A")).toBe(false);
    probe.stop();
  });
});

describe("OsProviderDrainSource", () => {
  const snapshot = [
    "100  1 /opt/homebrew/bin/claude",
    "101 100 /bin/zsh",
    "102 101 sleep",
    "200  1 /usr/local/bin/codex",
    "300  1 /usr/local/bin/codex",
  ].join("\n");

  const envForPid = async (pid: number): Promise<string> => {
    if (pid === 100) {
      return ["FIRST_TREE_CLIENT_ID=client_A", "FIRST_TREE_AGENT_ID=agent-A", "FIRST_TREE_CHAT_ID=chat-A"].join("\0");
    }
    if (pid === 200) {
      return ["FIRST_TREE_CLIENT_ID=client_B", "FIRST_TREE_AGENT_ID=agent-B", "FIRST_TREE_CHAT_ID=chat-B"].join("\0");
    }
    return ["FIRST_TREE_HOME=/tmp/first-tree", "FIRST_TREE_AGENT_ID=agent-old"].join("\0");
  };

  it("reports scoped provider processes and descendants for switch drain", async () => {
    const source = new OsProviderDrainSource({
      clientId: "client_A",
      runProcessSnapshot: async () => snapshot,
      runEnvForPid: envForPid,
    });

    const result = await source.snapshot();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.processes).toEqual([
      expect.objectContaining({
        pid: 100,
        provider: "claude",
        clientId: "client_A",
        agentId: "agent-A",
        chatId: "chat-A",
        descendantPids: [101, 102],
      }),
    ]);
  });

  it("can scope older provider processes by FIRST_TREE_HOME when client id is absent", async () => {
    const source = new OsProviderDrainSource({
      home: "/tmp/first-tree",
      runProcessSnapshot: async () => snapshot,
      runEnvForPid: envForPid,
    });

    const result = await source.snapshot();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.processes.map((p) => p.pid)).toEqual([300]);
  });

  it("fails closed when process snapshot is unavailable", async () => {
    const source = new OsProviderDrainSource({
      clientId: "client_A",
      runProcessSnapshot: async () => {
        throw new Error("ps denied");
      },
      runEnvForPid: envForPid,
    });

    await expect(source.snapshot()).resolves.toEqual({
      ok: false,
      reason: "provider process snapshot failed: ps denied",
    });
  });

  it("fails closed when a provider env cannot be read", async () => {
    const source = new OsProviderDrainSource({
      clientId: "client_A",
      runProcessSnapshot: async () => snapshot,
      runEnvForPid: async (pid) => {
        if (pid === 100) throw new Error("permission denied");
        return envForPid(pid);
      },
    });

    await expect(source.snapshot()).resolves.toEqual({
      ok: false,
      reason: "provider process env read failed for pid 100: permission denied",
    });
  });

  it("assertProviderDrainClear rejects live or unavailable drain snapshots", async () => {
    await expect(
      assertProviderDrainClear(
        new OsProviderDrainSource({
          clientId: "client_A",
          runProcessSnapshot: async () => snapshot,
          runEnvForPid: envForPid,
        }),
      ),
    ).rejects.toThrow("provider processes still live: claude pid 100 chat chat-A");

    await expect(
      assertProviderDrainClear(
        new OsProviderDrainSource({
          clientId: "client_A",
          runProcessSnapshot: async () => {
            throw new Error("ps denied");
          },
          runEnvForPid: envForPid,
        }),
      ),
    ).rejects.toThrow("provider drain source unavailable: provider process snapshot failed: ps denied");
  });

  it("assertProviderDrainClear resolves only after the scoped provider is gone", async () => {
    await expect(
      assertProviderDrainClear(
        new OsProviderDrainSource({
          clientId: "client_A",
          runProcessSnapshot: async () => "200 1 /usr/local/bin/codex",
          runEnvForPid: envForPid,
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
