import { describe, expect, it } from "vitest";
import {
  buildChildrenIndex,
  extractChatId,
  findProviderPids,
  hasDescendant,
  PsSubprocessProbe,
  parseProcessRows,
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

  it("extracts FIRST_TREE_CHAT_ID from a ps -E command line", () => {
    const line = "FIRST_TREE_HOME=/x FIRST_TREE_CHAT_ID=f93566d9-00c8 FIRST_TREE_AGENT_ID=019e /bin/claude";
    expect(extractChatId(line)).toBe("f93566d9-00c8");
    expect(extractChatId("no marker here")).toBeNull();
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
