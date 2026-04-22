import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDaemonConfig,
  loadDaemonConfig,
  parseDurationMs,
  resolveGardenerDir,
  writeDaemonConfig,
} from "#products/gardener/engine/daemon/config.js";
import {
  buildGardenerSweepArgs,
  buildSyncSweepArgs,
  formatMergedSince,
  parseBreezeResult,
  runOnce,
} from "#products/gardener/engine/daemon/loop.js";
import {
  isSweepDue,
  loadDaemonState,
  updateSweepState,
  writeDaemonState,
} from "#products/gardener/engine/daemon/state.js";
import {
  gardenerLaunchdLabel,
  renderLaunchdPlist,
  sanitizeLabelSegment,
} from "#products/gardener/engine/daemon/launchd.js";
import { runStatus } from "#products/gardener/engine/commands/status.js";
import { runStart } from "#products/gardener/engine/commands/start.js";
import { runStop } from "#products/gardener/engine/commands/stop.js";
import { useTmpDir } from "../helpers.js";

function makeEnv(dir: string): NodeJS.ProcessEnv {
  return { ...process.env, GARDENER_DIR: dir };
}

function capture(): { write: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return {
    write: (line: string) => {
      for (const split of line.split("\n")) lines.push(split);
    },
    lines,
  };
}

describe("gardener daemon -- parseDurationMs", () => {
  it("parses seconds, minutes, hours, days", () => {
    expect(parseDurationMs("30s")).toBe(30_000);
    expect(parseDurationMs("5m")).toBe(300_000);
    expect(parseDurationMs("2h")).toBe(7_200_000);
    expect(parseDurationMs("1d")).toBe(86_400_000);
  });
  it("treats bare integers as seconds", () => {
    expect(parseDurationMs("120")).toBe(120_000);
  });
  it("returns null on junk", () => {
    expect(parseDurationMs("0m")).toBeNull();
    expect(parseDurationMs("-1s")).toBeNull();
    expect(parseDurationMs("abc")).toBeNull();
    expect(parseDurationMs("")).toBeNull();
  });
});

describe("gardener daemon -- config I/O", () => {
  it("resolves GARDENER_DIR env override", () => {
    const tmp = useTmpDir();
    expect(resolveGardenerDir(makeEnv(tmp.path))).toBe(tmp.path);
  });

  it("writes and reads round-trip", () => {
    const tmp = useTmpDir();
    const env = makeEnv(tmp.path);
    const config = buildDaemonConfig({
      treePath: "/tmp/example-tree",
      codeRepos: ["a/b", "c/d"],
      gardenerIntervalMs: 60_000,
      syncIntervalMs: 3_600_000,
      assignOwners: true,
      syncApply: false,
    });
    writeDaemonConfig(config, env);
    const loaded = loadDaemonConfig(env);
    expect(loaded).not.toBeNull();
    expect(loaded?.codeRepos).toEqual(["a/b", "c/d"]);
    expect(loaded?.assignOwners).toBe(true);
    expect(loaded?.mergedLookbackSeconds).toBe(120); // 2× 60_000 ms → 120 s
  });

  it("returns null when no config file exists", () => {
    const tmp = useTmpDir();
    expect(loadDaemonConfig(makeEnv(tmp.path))).toBeNull();
  });

  it("resolves relative tree-path to absolute", () => {
    const config = buildDaemonConfig({
      treePath: "./some/relative/path",
      codeRepos: ["a/b"],
    });
    expect(config.treePath.startsWith("/")).toBe(true);
  });
});

describe("gardener daemon -- state helpers", () => {
  it("isSweepDue returns true when never run", () => {
    expect(isSweepDue({ sweeps: {} }, "gardener", 60_000, 1_000_000)).toBe(true);
  });

  it("isSweepDue returns false before interval elapses", () => {
    const state = {
      sweeps: {
        gardener: { lastRunAt: 1_000_000, outcome: "handled" as const, summary: "" },
      },
    };
    expect(isSweepDue(state, "gardener", 60_000, 1_030_000)).toBe(false);
  });

  it("isSweepDue returns true after interval elapses", () => {
    const state = {
      sweeps: {
        gardener: { lastRunAt: 1_000_000, outcome: "handled" as const, summary: "" },
      },
    };
    expect(isSweepDue(state, "gardener", 60_000, 1_061_000)).toBe(true);
  });

  it("updateSweepState round-trips to disk", () => {
    const tmp = useTmpDir();
    const env = makeEnv(tmp.path);
    updateSweepState(env, "gardener", {
      lastRunAt: 123_456,
      outcome: "handled",
      summary: "did stuff",
    });
    const loaded = loadDaemonState(env);
    expect(loaded.sweeps.gardener?.outcome).toBe("handled");
    expect(loaded.sweeps.gardener?.summary).toBe("did stuff");
  });
});

describe("gardener daemon -- formatMergedSince", () => {
  it("formats minutes when no larger unit divides cleanly", () => {
    expect(formatMergedSince(600)).toBe("10m");
    expect(formatMergedSince(120)).toBe("2m");
  });

  it("prefers hours when the duration is a whole number of hours", () => {
    expect(formatMergedSince(3600)).toBe("1h");
    expect(formatMergedSince(7200)).toBe("2h");
  });

  it("prefers days when the duration is a whole number of days", () => {
    expect(formatMergedSince(86400)).toBe("1d");
    expect(formatMergedSince(172800)).toBe("2d");
  });

  it("rounds sub-minute durations up to the parser's minimum (1m)", () => {
    expect(formatMergedSince(1)).toBe("1m");
    expect(formatMergedSince(59)).toBe("1m");
  });

  it("handles non-positive/NaN inputs safely", () => {
    expect(formatMergedSince(0)).toBe("1m");
    expect(formatMergedSince(-5)).toBe("1m");
    expect(formatMergedSince(Number.NaN)).toBe("1m");
  });

  it("never emits an `s` suffix (rejected by `gardener comment --merged-since`)", () => {
    for (const seconds of [1, 59, 60, 120, 600, 3599, 3600, 86399, 86400]) {
      expect(formatMergedSince(seconds)).not.toMatch(/s$/);
      expect(formatMergedSince(seconds)).toMatch(/^\d+[mhdw]$/);
    }
  });
});

describe("gardener daemon -- sweep arg builders", () => {
  it("gardener sweep passes --merged-since and assign-owners when enabled", () => {
    const config = buildDaemonConfig({
      treePath: "/x",
      codeRepos: ["a/b"],
      gardenerIntervalMs: 300_000,
      assignOwners: true,
    });
    const args = buildGardenerSweepArgs(config);
    expect(args).toContain("gardener");
    expect(args).toContain("comment");
    expect(args).toContain("--merged-since");
    const idx = args.indexOf("--merged-since");
    // Must be m/h/d/w — `gardener comment --merged-since` rejects `s`.
    expect(args[idx + 1]).toMatch(/^\d+[mhdw]$/);
    expect(args).toContain("--assign-owners");
  });

  it("sync sweep passes --apply only when syncApply=true", () => {
    const base = buildDaemonConfig({ treePath: "/x", codeRepos: ["a/b"] });
    expect(buildSyncSweepArgs(base)).not.toContain("--apply");
    const applied = buildDaemonConfig({
      treePath: "/x",
      codeRepos: ["a/b"],
      syncApply: true,
    });
    expect(buildSyncSweepArgs(applied)).toContain("--apply");
  });
});

describe("gardener daemon -- parseBreezeResult", () => {
  it("extracts status and summary", () => {
    const stdout = [
      "some noise",
      "gardener-comment run complete",
      "BREEZE_RESULT: status=handled summary=repos=2 handled=1 skipped=1 failed=0 tree_repo_token=absent",
    ].join("\n");
    const parsed = parseBreezeResult(stdout);
    expect(parsed?.status).toBe("handled");
    expect(parsed?.summary).toContain("repos=2");
  });

  it("returns null when no trailer present", () => {
    expect(parseBreezeResult("no trailer here")).toBeNull();
  });
});

describe("gardener daemon -- runOnce dispatch", () => {
  it("invokes both sweeps and records outcomes", async () => {
    const tmp = useTmpDir();
    const env = makeEnv(tmp.path);
    writeDaemonConfig(
      buildDaemonConfig({
        treePath: "/tmp/whatever",
        codeRepos: ["a/b"],
      }),
      env,
    );
    const { write, lines } = capture();
    const calls: string[] = [];
    const results = await runOnce({
      env,
      now: () => 1_000_000,
      write,
      runSweep: async (sweep) => {
        calls.push(sweep);
        return {
          outcome: "handled",
          summary: `${sweep} did things`,
        };
      },
    });
    expect(calls).toEqual(["gardener", "sync"]);
    expect(results.gardener?.outcome).toBe("handled");
    expect(results.sync?.outcome).toBe("handled");
    const state = loadDaemonState(env);
    expect(state.sweeps.gardener?.lastRunAt).toBe(1_000_000);
    expect(state.sweeps.sync?.lastRunAt).toBe(1_000_000);
    expect(lines.some((l) => l.includes("gardener-sweep handled"))).toBe(true);
  });

  it("fails gracefully when no config exists", async () => {
    const tmp = useTmpDir();
    const env = makeEnv(tmp.path);
    const { write, lines } = capture();
    const results = await runOnce({ env, write, runSweep: async () => ({
      outcome: "handled",
      summary: "",
    }) });
    expect(results.gardener).toBeUndefined();
    expect(results.sync).toBeUndefined();
    expect(lines.some((l) => l.includes("no config"))).toBe(true);
  });
});

describe("gardener daemon -- status", () => {
  it("reports <not running> + <missing> when nothing configured", async () => {
    const tmp = useTmpDir();
    const env = makeEnv(tmp.path);
    const { write, lines } = capture();
    const code = await runStatus([], { env, write, now: () => 1_000_000 });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("<not running>");
    expect(lines.join("\n")).toContain("<missing");
  });

  it("reports last-run + next-in when state present", async () => {
    const tmp = useTmpDir();
    const env = makeEnv(tmp.path);
    writeDaemonConfig(
      buildDaemonConfig({
        treePath: "/x",
        codeRepos: ["a/b"],
        gardenerIntervalMs: 300_000,
        syncIntervalMs: 3_600_000,
      }),
      env,
    );
    updateSweepState(env, "gardener", {
      lastRunAt: 900_000,
      outcome: "handled",
      summary: "repos=1 handled=1",
    });
    const { write, lines } = capture();
    await runStatus([], { env, write, now: () => 1_000_000 });
    const body = lines.join("\n");
    expect(body).toContain("gardener-sweep: last handled");
    expect(body).toContain("repos=1 handled=1");
    expect(body).toContain("next in");
  });
});

describe("gardener daemon -- start --dry-run", () => {
  it("writes config without booting daemon", async () => {
    const tmp = useTmpDir();
    const env = makeEnv(tmp.path);
    const { write, lines } = capture();
    const code = await runStart(
      [
        "--tree-path",
        tmp.path,
        "--code-repo",
        "a/b",
        "--code-repo",
        "c/d",
        "--gardener-interval",
        "10m",
        "--sync-interval",
        "2h",
        "--assign-owners",
        "--dry-run",
      ],
      { env, write },
    );
    expect(code).toBe(0);
    const config = loadDaemonConfig(env);
    expect(config?.codeRepos).toEqual(["a/b", "c/d"]);
    expect(config?.gardenerIntervalMs).toBe(600_000);
    expect(config?.syncIntervalMs).toBe(7_200_000);
    expect(config?.assignOwners).toBe(true);
    expect(lines.some((l) => l.includes("not booting"))).toBe(true);
  });

  it("rejects missing --tree-path", async () => {
    const tmp = useTmpDir();
    const env = makeEnv(tmp.path);
    const { write, lines } = capture();
    const code = await runStart(["--code-repo", "a/b", "--dry-run"], {
      env,
      write,
    });
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("--tree-path is required"))).toBe(true);
  });

  it("rejects bad --gardener-interval", async () => {
    const tmp = useTmpDir();
    const env = makeEnv(tmp.path);
    const { write, lines } = capture();
    const code = await runStart(
      [
        "--tree-path",
        tmp.path,
        "--code-repo",
        "a/b",
        "--gardener-interval",
        "zzz",
        "--dry-run",
      ],
      { env, write },
    );
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("--gardener-interval"))).toBe(true);
  });
});

describe("gardener daemon -- stop idempotency", () => {
  it("reports nothing to stop on a clean state", async () => {
    const tmp = useTmpDir();
    const env = makeEnv(tmp.path);
    const { write, lines } = capture();
    const code = await runStop([], { env, write });
    expect(code).toBe(0);
    if (process.platform !== "darwin") {
      expect(lines.some((l) => l.includes("nothing to stop"))).toBe(true);
    }
  });

  it("clears the pid from state", async () => {
    const tmp = useTmpDir();
    const env = makeEnv(tmp.path);
    // Use a PID that definitely doesn't exist to avoid signaling real processes.
    writeDaemonState({ pid: 2_147_483_646, startedAt: 1, sweeps: {} }, env);
    const { write } = capture();
    await runStop([], { env, write });
    const state = loadDaemonState(env);
    expect(state.pid).toBeUndefined();
  });
});

describe("gardener daemon -- launchd helpers", () => {
  it("sanitizes label segments", () => {
    expect(sanitizeLabelSegment("alice")).toBe("alice");
    expect(sanitizeLabelSegment("alice/bob")).toBe("alice_bob");
    expect(sanitizeLabelSegment("alice@example.com")).toBe("alice_example.com");
  });

  it("builds a namespaced label", () => {
    expect(gardenerLaunchdLabel("alice")).toBe("com.first-tree.gardener.alice");
  });

  it("renders a plist with escaped args + env", () => {
    const plist = renderLaunchdPlist({
      label: "com.first-tree.gardener.alice",
      executable: "/usr/bin/node",
      arguments: ["/cli.js", "gardener", "daemon"],
      logPath: "/tmp/log.log",
      env: { HOME: "/Users/alice", PATH: "/usr/bin" },
      workingDirectory: "/Users/alice/tree",
    });
    expect(plist).toContain("<string>com.first-tree.gardener.alice</string>");
    expect(plist).toContain("<string>/usr/bin/node</string>");
    expect(plist).toContain("<string>gardener</string>");
    expect(plist).toContain("<string>daemon</string>");
    expect(plist).toContain("<key>HOME</key>");
    expect(plist).toContain("<string>/Users/alice</string>");
    expect(plist).toContain("<key>WorkingDirectory</key>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
  });
});
