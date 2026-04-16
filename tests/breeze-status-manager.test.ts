/**
 * status-manager CLI parity + behaviour tests.
 *
 * Most tests exercise the TS port directly with stubbed `gh`. One
 * end-to-end parity test diffs the TS stdout against the bash script
 * for the subset of commands that are safe to run without `gh` network
 * access (get / list / count / release).
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runStatusManager } from "../src/products/breeze/commands/status-manager.js";
import { resolveBreezePaths } from "../src/products/breeze/core/paths.js";
import { GhClient } from "../src/products/breeze/core/gh.js";
import { readActivityLog } from "../src/products/breeze/core/activity-log.js";

const FIXTURE = join(__dirname, "fixtures", "breeze", "inbox-sample.json");
const BASH_SCRIPT = join(
  __dirname,
  "..",
  "assets",
  "breeze",
  "bin",
  "breeze-status-manager",
);

function mkBreezeDir(): { dir: string; inbox: string; activity: string; claims: string } {
  const dir = mkdtempSync(join(tmpdir(), "breeze-sm-"));
  mkdirSync(join(dir, "claims"), { recursive: true });
  const inbox = join(dir, "inbox.json");
  const activity = join(dir, "activity.log");
  // Copy the fixture so each test has a clean writable inbox.
  writeFileSync(inbox, readFileSync(FIXTURE, "utf-8"), "utf-8");
  return { dir, inbox, activity, claims: join(dir, "claims") };
}

function captureIO(): {
  stdout: string[];
  stderr: string[];
  io: { stdout: (s: string) => void; stderr: (s: string) => void };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (s) => stdout.push(s),
      stderr: (s) => stderr.push(s),
    },
  };
}

/** Stub spawn that always returns success. */
function passthroughSpawn() {
  return vi.fn().mockReturnValue({
    pid: 1,
    status: 0,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    output: [],
  });
}

describe("status-manager: get", () => {
  let ctx: ReturnType<typeof mkBreezeDir>;
  beforeEach(() => {
    ctx = mkBreezeDir();
  });
  afterEach(() => rmSync(ctx.dir, { recursive: true, force: true }));

  it("returns breeze_status for an existing id", async () => {
    const { stdout, io } = captureIO();
    const paths = resolveBreezePaths({ env: () => ctx.dir });
    const code = await runStatusManager(["get", "23576674031"], { io, paths });
    expect(code).toBe(0);
    expect(stdout).toEqual(["wip"]);
  });

  it("returns `new` for unknown id", async () => {
    const { stdout, io } = captureIO();
    const paths = resolveBreezePaths({ env: () => ctx.dir });
    const code = await runStatusManager(["get", "nonexistent"], { io, paths });
    expect(code).toBe(0);
    expect(stdout).toEqual(["new"]);
  });

  it("returns `wip (claimed)` when a fresh claim exists", async () => {
    const claimDir = join(ctx.claims, "23576674030");
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(join(claimDir, "claimed_at"), "2026-04-16T20:15:30Z\n", "utf-8");
    writeFileSync(join(claimDir, "claimed_by"), "session-a\n", "utf-8");
    writeFileSync(join(claimDir, "action"), "working\n", "utf-8");
    const { stdout, io } = captureIO();
    const paths = resolveBreezePaths({ env: () => ctx.dir });
    const code = await runStatusManager(["get", "23576674030"], {
      io,
      paths,
      now: () => new Date("2026-04-16T20:15:35Z"),
    });
    expect(code).toBe(0);
    expect(stdout).toEqual(["wip (claimed)"]);
  });

  it("falls through to inbox when claim is stale", async () => {
    const claimDir = join(ctx.claims, "23576674030");
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(join(claimDir, "claimed_at"), "2026-04-16T20:15:30Z\n", "utf-8");
    const { stdout, io } = captureIO();
    const paths = resolveBreezePaths({ env: () => ctx.dir });
    const code = await runStatusManager(["get", "23576674030"], {
      io,
      paths,
      now: () => new Date("2026-04-16T20:25:30Z"), // 10 minutes later
      claimTimeoutSecs: 300,
    });
    expect(code).toBe(0);
    expect(stdout).toEqual(["new"]);
  });
});

describe("status-manager: list / count", () => {
  let ctx: ReturnType<typeof mkBreezeDir>;
  beforeEach(() => {
    ctx = mkBreezeDir();
  });
  afterEach(() => rmSync(ctx.dir, { recursive: true, force: true }));

  it("list defaults to --status new", async () => {
    const { stdout, io } = captureIO();
    const paths = resolveBreezePaths({ env: () => ctx.dir });
    const code = await runStatusManager(["list"], { io, paths });
    expect(code).toBe(0);
    expect(stdout).toEqual(["23576674030", "23576674033"]);
  });

  it("list --status wip", async () => {
    const { stdout, io } = captureIO();
    const paths = resolveBreezePaths({ env: () => ctx.dir });
    const code = await runStatusManager(["list", "--status", "wip"], { io, paths });
    expect(code).toBe(0);
    expect(stdout).toEqual(["23576674031"]);
  });

  it("count --status done", async () => {
    const { stdout, io } = captureIO();
    const paths = resolveBreezePaths({ env: () => ctx.dir });
    const code = await runStatusManager(["count", "--status", "done"], { io, paths });
    expect(code).toBe(0);
    expect(stdout).toEqual(["1"]);
  });

  it("count default is --status new", async () => {
    const { stdout, io } = captureIO();
    const paths = resolveBreezePaths({ env: () => ctx.dir });
    const code = await runStatusManager(["count"], { io, paths });
    expect(code).toBe(0);
    expect(stdout).toEqual(["2"]);
  });
});

describe("status-manager: claim / release", () => {
  let ctx: ReturnType<typeof mkBreezeDir>;
  beforeEach(() => {
    ctx = mkBreezeDir();
  });
  afterEach(() => rmSync(ctx.dir, { recursive: true, force: true }));

  it("claim creates the directory and prints `claimed`", async () => {
    const { stdout, io } = captureIO();
    const paths = resolveBreezePaths({ env: () => ctx.dir });
    const code = await runStatusManager(
      ["claim", "23576674030", "session-a"],
      { io, paths, now: () => new Date("2026-04-16T20:15:30Z") },
    );
    expect(code).toBe(0);
    expect(stdout).toEqual(["claimed"]);
    expect(existsSync(join(ctx.claims, "23576674030", "claimed_by"))).toBe(true);
    expect(
      readFileSync(join(ctx.claims, "23576674030", "claimed_by"), "utf-8"),
    ).toBe("session-a\n");
    expect(
      readFileSync(join(ctx.claims, "23576674030", "action"), "utf-8"),
    ).toBe("working\n");

    // An activity-log `claimed` event was appended.
    const events = readActivityLog(ctx.activity);
    const claimed = events.find((e) => e.event === "claimed");
    expect(claimed).toBeDefined();
    if (claimed?.event === "claimed") {
      expect(claimed.by).toBe("session-a");
      expect(claimed.action).toBe("working");
    }
  });

  it("claim honors a custom action positional arg", async () => {
    const { stdout, io } = captureIO();
    const paths = resolveBreezePaths({ env: () => ctx.dir });
    await runStatusManager(
      ["claim", "23576674030", "session-a", "refactoring"],
      { io, paths },
    );
    expect(stdout).toEqual(["claimed"]);
    expect(
      readFileSync(join(ctx.claims, "23576674030", "action"), "utf-8"),
    ).toBe("refactoring\n");
  });

  it("claim on an already-claimed id prints `already_claimed:<owner>`", async () => {
    // First claim.
    const first = captureIO();
    const paths = resolveBreezePaths({ env: () => ctx.dir });
    await runStatusManager(["claim", "23576674030", "session-a"], {
      io: first.io,
      paths,
      now: () => new Date("2026-04-16T20:15:30Z"),
    });
    // Second claim shortly after.
    const second = captureIO();
    const code = await runStatusManager(["claim", "23576674030", "session-b"], {
      io: second.io,
      paths,
      now: () => new Date("2026-04-16T20:15:31Z"),
    });
    expect(code).toBe(0);
    expect(second.stdout).toEqual(["already_claimed:session-a"]);
  });

  it("claim reclaims a stale (>300s) claim", async () => {
    const paths = resolveBreezePaths({ env: () => ctx.dir });
    // First claim at t=0.
    await runStatusManager(["claim", "23576674030", "session-a"], {
      io: captureIO().io,
      paths,
      now: () => new Date("2026-04-16T20:15:30Z"),
    });
    // Second claim 10 minutes later.
    const second = captureIO();
    const code = await runStatusManager(["claim", "23576674030", "session-b"], {
      io: second.io,
      paths,
      now: () => new Date("2026-04-16T20:25:31Z"),
    });
    expect(code).toBe(0);
    expect(second.stdout).toEqual(["claimed"]);
    expect(
      readFileSync(join(ctx.claims, "23576674030", "claimed_by"), "utf-8"),
    ).toBe("session-b\n");
  });

  it("release removes the claim directory and prints `released`", async () => {
    const paths = resolveBreezePaths({ env: () => ctx.dir });
    const claimDir = join(ctx.claims, "23576674030");
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(join(claimDir, "claimed_by"), "session-a\n", "utf-8");
    const { stdout, io } = captureIO();
    const code = await runStatusManager(["release", "23576674030"], { io, paths });
    expect(code).toBe(0);
    expect(stdout).toEqual(["released"]);
    expect(existsSync(claimDir)).toBe(false);
  });
});

describe("status-manager: set", () => {
  let ctx: ReturnType<typeof mkBreezeDir>;
  beforeEach(() => {
    ctx = mkBreezeDir();
  });
  afterEach(() => rmSync(ctx.dir, { recursive: true, force: true }));

  it("errors loudly if repo/number missing", async () => {
    // Overwrite one entry's number to null.
    const raw = JSON.parse(readFileSync(ctx.inbox, "utf-8")) as {
      notifications: Array<{ id: string; number: number | null }>;
    };
    raw.notifications[0].number = null;
    writeFileSync(ctx.inbox, JSON.stringify(raw), "utf-8");
    const { stderr, io } = captureIO();
    const paths = resolveBreezePaths({ env: () => ctx.dir });
    const code = await runStatusManager(
      ["set", raw.notifications[0].id, "wip"],
      { io, paths },
    );
    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(/cannot find repo\/number/u);
  });

  it("rejects unknown status", async () => {
    const { stderr, io } = captureIO();
    const paths = resolveBreezePaths({ env: () => ctx.dir });
    const code = await runStatusManager(
      ["set", "23576674030", "nonsense"],
      { io, paths },
    );
    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(/unknown status/u);
  });

  it("removes all breeze labels then adds the target label and patches inbox", async () => {
    const calls: string[][] = [];
    const gh = new GhClient({
      spawn: vi.fn().mockImplementation((_cmd, argv: string[]) => {
        calls.push([...argv]);
        return {
          pid: 1,
          status: 0,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          output: [],
        };
      }),
    });
    const { stdout, io } = captureIO();
    const paths = resolveBreezePaths({ env: () => ctx.dir });
    const code = await runStatusManager(
      [
        "set",
        "23576674030",
        "wip",
        "--by",
        "session-a",
        "--reason",
        "picked up from PR",
      ],
      {
        io,
        paths,
        gh,
        now: () => new Date("2026-04-16T20:15:30Z"),
      },
    );
    expect(code).toBe(0);
    expect(stdout).toEqual(["wip"]);

    // Removes every breeze:* label.
    const removeCalls = calls.filter((c) => c.includes("--remove-label"));
    expect(removeCalls).toHaveLength(4);
    const removedLabels = removeCalls
      .map((c) => c[c.indexOf("--remove-label") + 1])
      .sort();
    expect(removedLabels).toEqual([
      "breeze:done",
      "breeze:human",
      "breeze:new",
      "breeze:wip",
    ]);

    // Adds breeze:wip.
    const addCalls = calls.filter((c) => c.includes("--add-label"));
    expect(addCalls.length).toBeGreaterThanOrEqual(1);
    expect(addCalls[0][addCalls[0].indexOf("--add-label") + 1]).toBe("breeze:wip");

    // Inbox was patched optimistically.
    const reparsed = JSON.parse(readFileSync(ctx.inbox, "utf-8")) as {
      notifications: Array<{ id: string; breeze_status: string }>;
    };
    const entry = reparsed.notifications.find((n) => n.id === "23576674030");
    expect(entry?.breeze_status).toBe("wip");

    // Activity-log transition event appended.
    const events = readActivityLog(ctx.activity);
    const transition = events.find((e) => e.event === "transition");
    expect(transition).toBeDefined();
    if (transition?.event === "transition") {
      expect(transition.from).toBe("new");
      expect(transition.to).toBe("wip");
      expect(transition.by).toBe("session-a");
      expect(transition.reason).toBe("picked up from PR");
    }
  });

  it("set new does not add any label", async () => {
    const calls: string[][] = [];
    const gh = new GhClient({
      spawn: vi.fn().mockImplementation((_cmd, argv: string[]) => {
        calls.push([...argv]);
        return {
          pid: 1,
          status: 0,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          output: [],
        };
      }),
    });
    const { io } = captureIO();
    const paths = resolveBreezePaths({ env: () => ctx.dir });
    await runStatusManager(["set", "23576674030", "new"], { io, paths, gh });
    const addCalls = calls.filter((c) => c.includes("--add-label"));
    expect(addCalls).toHaveLength(0);
  });

  it("set removes the claim directory when new status is not wip", async () => {
    const paths = resolveBreezePaths({ env: () => ctx.dir });
    const claimDir = join(ctx.claims, "23576674030");
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(join(claimDir, "claimed_by"), "session-a\n", "utf-8");
    const gh = new GhClient({ spawn: passthroughSpawn() });
    const { io } = captureIO();
    await runStatusManager(["set", "23576674030", "done"], {
      io,
      paths,
      gh,
    });
    expect(existsSync(claimDir)).toBe(false);
  });

  it("set does NOT remove the claim when new status is wip", async () => {
    const paths = resolveBreezePaths({ env: () => ctx.dir });
    const claimDir = join(ctx.claims, "23576674030");
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(join(claimDir, "claimed_by"), "session-a\n", "utf-8");
    const gh = new GhClient({ spawn: passthroughSpawn() });
    const { io } = captureIO();
    await runStatusManager(["set", "23576674030", "wip"], {
      io,
      paths,
      gh,
    });
    expect(existsSync(claimDir)).toBe(true);
  });
});

describe("status-manager: ensure-labels", () => {
  let ctx: ReturnType<typeof mkBreezeDir>;
  beforeEach(() => {
    ctx = mkBreezeDir();
  });
  afterEach(() => rmSync(ctx.dir, { recursive: true, force: true }));

  it("creates all four breeze labels with correct colors", async () => {
    const calls: string[][] = [];
    const gh = new GhClient({
      spawn: vi.fn().mockImplementation((_cmd, argv: string[]) => {
        calls.push([...argv]);
        return {
          pid: 1,
          status: 0,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          output: [],
        };
      }),
    });
    const { stdout, io } = captureIO();
    const paths = resolveBreezePaths({ env: () => ctx.dir });
    const code = await runStatusManager(["ensure-labels", "owner/repo"], {
      io,
      paths,
      gh,
    });
    expect(code).toBe(0);
    expect(stdout.join("\n")).toContain("Creating breeze labels on owner/repo");
    expect(stdout.join("\n")).toContain("Labels created on owner/repo");
    // 4 label create calls.
    expect(calls).toHaveLength(4);
    const labels = calls.map((c) => c[2]).sort();
    expect(labels).toEqual([
      "breeze:done",
      "breeze:human",
      "breeze:new",
      "breeze:wip",
    ]);
    // Colors match spec §7.
    const colorFor = (label: string): string => {
      const call = calls.find((c) => c[2] === label)!;
      return call[call.indexOf("--color") + 1];
    };
    expect(colorFor("breeze:new")).toBe("0075ca");
    expect(colorFor("breeze:wip")).toBe("e4e669");
    expect(colorFor("breeze:human")).toBe("d93f0b");
    expect(colorFor("breeze:done")).toBe("0e8a16");
  });
});

describe("status-manager: help", () => {
  it("prints usage and exits 0", async () => {
    const { stdout, io } = captureIO();
    const code = await runStatusManager(["help"], { io });
    expect(code).toBe(0);
    expect(stdout[0]).toMatch(/Usage: breeze-status-manager/u);
  });
});

describe("status-manager: bash parity (read-only commands)", () => {
  // The bash script writes labels via `gh`, so parity for `set` requires a
  // real GitHub. We diff only the purely-local read commands: get, list,
  // count, release. These all just read inbox.json / claims/ and print to
  // stdout.
  let ctx: ReturnType<typeof mkBreezeDir>;
  beforeEach(() => {
    ctx = mkBreezeDir();
  });
  afterEach(() => rmSync(ctx.dir, { recursive: true, force: true }));

  function bash(argv: string[]): { stdout: string; status: number } {
    try {
      const stdout = execFileSync(BASH_SCRIPT, argv, {
        env: { ...process.env, BREEZE_DIR: ctx.dir },
        encoding: "utf-8",
      });
      return { stdout, status: 0 };
    } catch (err) {
      const e = err as { stdout?: string; status?: number };
      return { stdout: e.stdout ?? "", status: e.status ?? 1 };
    }
  }

  async function ts(argv: string[]): Promise<{ stdout: string; status: number }> {
    const { stdout, io } = captureIO();
    const paths = resolveBreezePaths({ env: () => ctx.dir });
    const code = await runStatusManager(argv, { io, paths });
    // Match bash trailing-newline behaviour.
    return { stdout: stdout.map((l) => `${l}\n`).join(""), status: code };
  }

  it("get matches bash for wip entry", async () => {
    const b = bash(["get", "23576674031"]);
    const t = await ts(["get", "23576674031"]);
    expect(t).toEqual(b);
  });

  it("get matches bash for unknown id (→ new)", async () => {
    const b = bash(["get", "no-such-id"]);
    const t = await ts(["get", "no-such-id"]);
    expect(t).toEqual(b);
  });

  it("list --status new matches bash", async () => {
    const b = bash(["list", "--status", "new"]);
    const t = await ts(["list", "--status", "new"]);
    expect(t).toEqual(b);
  });

  it("list --status wip matches bash", async () => {
    const b = bash(["list", "--status", "wip"]);
    const t = await ts(["list", "--status", "wip"]);
    expect(t).toEqual(b);
  });

  it("count --status done matches bash", async () => {
    const b = bash(["count", "--status", "done"]);
    const t = await ts(["count", "--status", "done"]);
    expect(t).toEqual(b);
  });

  it("release matches bash", async () => {
    // Pre-create a claim dir so both have something to release.
    const d1 = join(ctx.claims, "23576674030");
    mkdirSync(d1, { recursive: true });
    const b = bash(["release", "23576674030"]);
    // Recreate the dir for TS since bash just removed it.
    mkdirSync(d1, { recursive: true });
    const t = await ts(["release", "23576674030"]);
    expect(t).toEqual(b);
  });
});
