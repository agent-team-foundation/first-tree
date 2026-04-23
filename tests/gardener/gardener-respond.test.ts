import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import {
  GARDENER_USAGE,
  runGardener,
} from "#products/gardener/cli.js";
import {
  classifyReviewDecision,
  extractSourcePr,
  hasSyncLabel,
  isFromGardener,
  isSyncPr,
  latestChangesRequestedAt,
  latestCommitTimeFromCommits,
  readRespondAttempts,
  readSnapshot,
  RESPOND_MAX_ATTEMPTS,
  RESPOND_USAGE,
  runRespond,
  writeRespondAttempts,
  type ShellResult,
  type ShellRun,
} from "#products/gardener/engine/respond.js";
import {
  isModuleEnabled,
  loadGardenerConfig,
} from "#products/gardener/engine/runtime/config.js";
import { useTmpDir } from "../helpers.js";

function writeConfig(treeRoot: string, yaml: string): void {
  const dir = join(treeRoot, ".claude");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "gardener-config.yaml"), yaml);
}

interface ShellCall {
  command: string;
  args: string[];
  cwd?: string;
}

function makeShell(
  handlers: Array<(call: ShellCall) => ShellResult | null>,
  calls: ShellCall[] = [],
): ShellRun {
  return async (command, args, options) => {
    const call: ShellCall = { command, args, cwd: options?.cwd };
    calls.push(call);
    for (const handler of handlers) {
      const result = handler(call);
      if (result) return result;
    }
    return { stdout: "", stderr: `no mock for ${command} ${args.join(" ")}`, code: 1 };
  };
}

function captureWrite(): { write: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return {
    write: (line: string): void => {
      for (const split of line.split("\n")) lines.push(split);
    },
    lines,
  };
}

describe("gardener config -- loadGardenerConfig / isModuleEnabled", () => {
  it("returns null when the file is missing (default enabled)", () => {
    const tmp = useTmpDir();
    expect(loadGardenerConfig(tmp.path)).toBeNull();
    expect(isModuleEnabled(null, "respond")).toBe(true);
  });

  it("treats empty modules block as default enabled", () => {
    const tmp = useTmpDir();
    writeConfig(tmp.path, "modules:\n");
    const config = loadGardenerConfig(tmp.path);
    expect(config).not.toBeNull();
    expect(isModuleEnabled(config, "respond")).toBe(true);
  });

  it("parses modules.respond.enabled: false", () => {
    const tmp = useTmpDir();
    writeConfig(tmp.path, "modules:\n  respond:\n    enabled: false\n");
    const config = loadGardenerConfig(tmp.path);
    expect(config).not.toBeNull();
    expect(isModuleEnabled(config, "respond")).toBe(false);
    // Other modules default to enabled.
    expect(isModuleEnabled(config, "sync")).toBe(true);
  });

  it("parses target_repos list", () => {
    const tmp = useTmpDir();
    writeConfig(
      tmp.path,
      [
        "tree_repo: agent-team-foundation/first-tree",
        "installed_version: 0.1.0",
        "target_repos:",
        "  - paperclipai/paperclip",
        "  - example/repo",
        "modules:",
        "  respond:",
        "    enabled: true",
        "",
      ].join("\n"),
    );
    const config = loadGardenerConfig(tmp.path);
    expect(config?.tree_repo).toBe("agent-team-foundation/first-tree");
    expect(config?.installed_version).toBe("0.1.0");
    expect(config?.target_repos).toEqual([
      "paperclipai/paperclip",
      "example/repo",
    ]);
    expect(isModuleEnabled(config, "respond")).toBe(true);
  });
});

describe("gardener CLI dispatch", () => {
  it("gardener --help prints usage", async () => {
    const { write, lines } = captureWrite();
    const code = await runCli(["gardener", "--help"], write);
    expect(code).toBe(0);
    const joined = lines.join("\n");
    expect(joined).toContain(GARDENER_USAGE);
  });

  it("gardener respond --help prints respond usage", async () => {
    const { write, lines } = captureWrite();
    const code = await runCli(["gardener", "respond", "--help"], write);
    expect(code).toBe(0);
    const joined = lines.join("\n");
    expect(joined).toContain(RESPOND_USAGE);
  });

  it("gardener unknown subcommand returns 1 with error", async () => {
    const { write, lines } = captureWrite();
    const code = await runCli(["gardener", "unknown-cmd"], write);
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("Unknown gardener command"))).toBe(true);
  });

  it("gardener --version prints the gardener product version", async () => {
    const { write, lines } = captureWrite();
    const code = await runGardener(["--version"], write);
    expect(code).toBe(0);
    expect(lines.some((l) => /^\d+\.\d+\.\d+$/.test(l.trim()))).toBe(true);
  });
});

describe("gardener respond -- config opt-out", () => {
  it("exits 0 with opt-out message and does not call gh", async () => {
    const tmp = useTmpDir();
    writeConfig(tmp.path, "modules:\n  respond:\n    enabled: false\n");
    const calls: ShellCall[] = [];
    const shell = makeShell([], calls);
    const { write, lines } = captureWrite();
    const code = await runRespond(
      ["--tree-path", tmp.path],
      { shellRun: shell, write, env: {}, now: () => new Date("2026-04-16T00:00:00Z") },
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    const joined = lines.join("\n");
    expect(joined).toContain("disabled via .claude/gardener-config.yaml");
  });
});

describe("gardener respond -- BREEZE_RESULT trailer", () => {
  it("emits BREEZE_RESULT on help path", async () => {
    const { write, lines } = captureWrite();
    const code = await runRespond(["--help"], { write });
    expect(code).toBe(0);
    expect(lines[lines.length - 1]).toMatch(/^BREEZE_RESULT: status=\w+ summary=.+/);
  });

  it("emits BREEZE_RESULT on opt-out path", async () => {
    const tmp = useTmpDir();
    writeConfig(tmp.path, "modules:\n  respond:\n    enabled: false\n");
    const { write, lines } = captureWrite();
    const shell = makeShell([]);
    const code = await runRespond(
      ["--tree-path", tmp.path],
      { shellRun: shell, write, env: {} },
    );
    expect(code).toBe(0);
    const last = lines[lines.length - 1];
    expect(last).toMatch(/^BREEZE_RESULT: status=skipped summary=/);
  });

  it("emits BREEZE_RESULT on bad-flag path", async () => {
    const { write, lines } = captureWrite();
    const code = await runRespond(["--nope"], { write, env: {} });
    expect(code).toBe(1);
    expect(lines[lines.length - 1]).toMatch(/^BREEZE_RESULT: status=failed /);
  });
});

describe("gardener respond -- single-PR only (scan mode removed, #160/#162 step 5)", () => {
  it("exits 1 with a clear error when invoked with no --pr/--repo", async () => {
    const tmp = useTmpDir();
    const calls: ShellCall[] = [];
    const shell = makeShell([], calls);
    const { write, lines } = captureWrite();
    const code = await runRespond(
      ["--tree-path", tmp.path],
      {
        shellRun: shell,
        write,
        // Pre-set GARDENER_LOGIN so resolveGardenerLogin doesn't make a
        // `gh api /user` call — this test only cares about dispatch, not
        // login resolution.
        env: { GARDENER_LOGIN: "gardener-bot" },
        now: () => new Date("2026-04-17T00:00:00Z"),
      },
    );
    expect(code).toBe(1);
    // No gh calls should happen — we reject before any scan/fetch I/O.
    expect(calls.filter((c) => c.command === "gh")).toHaveLength(0);
    const joined = lines.join("\n");
    expect(joined).toContain("--pr and --repo are required");
    expect(lines[lines.length - 1]).toMatch(
      /^BREEZE_RESULT: status=failed summary=pr\/repo flags required/,
    );
  });

  it("exits 1 when only --pr is supplied (no --repo)", async () => {
    const tmp = useTmpDir();
    const { write, lines } = captureWrite();
    const shell = makeShell([]);
    const code = await runRespond(
      ["--pr", "42", "--tree-path", tmp.path],
      { shellRun: shell, write, env: { GARDENER_LOGIN: "gardener-bot" } },
    );
    expect(code).toBe(1);
    expect(lines[lines.length - 1]).toMatch(/^BREEZE_RESULT: status=failed /);
  });

  it("exits 1 when only --repo is supplied (no --pr)", async () => {
    const tmp = useTmpDir();
    const { write, lines } = captureWrite();
    const shell = makeShell([]);
    const code = await runRespond(
      ["--repo", "alice/tree", "--tree-path", tmp.path],
      { shellRun: shell, write, env: { GARDENER_LOGIN: "gardener-bot" } },
    );
    expect(code).toBe(1);
    expect(lines[lines.length - 1]).toMatch(/^BREEZE_RESULT: status=failed /);
  });

  it("does not invoke `gh pr list` (scan mode is removed)", async () => {
    const tmp = useTmpDir();
    const calls: ShellCall[] = [];
    const shell = makeShell([], calls);
    const { write } = captureWrite();
    // Invoke with no flags — would have triggered scan-mode on main, now rejects.
    await runRespond(
      ["--tree-path", tmp.path],
      { shellRun: shell, write, env: { GARDENER_LOGIN: "gardener-bot" } },
    );
    // Assert no gh pr list call happened. (Under the old scan-mode path, this
    // was the first gh call after `gh repo view`.)
    const prListCalls = calls.filter(
      (c) => c.command === "gh" && c.args[0] === "pr" && c.args[1] === "list",
    );
    expect(prListCalls).toHaveLength(0);
  });

  it("help text documents single-PR-only invocation", () => {
    // The pre-refactor "Modes: (default) Scan ..." section is gone.
    expect(RESPOND_USAGE).not.toMatch(/^\s*Modes:/m);
    expect(RESPOND_USAGE).not.toMatch(/\(default\)\s+Scan/);
    // The required single-PR flags are documented.
    expect(RESPOND_USAGE).toContain("--pr <n>");
    expect(RESPOND_USAGE).toContain("--repo <owner/name>");
    expect(RESPOND_USAGE).toContain("required");
    // The synopsis line no longer wraps --pr/--repo in brackets
    // (they're not optional anymore).
    expect(RESPOND_USAGE).toMatch(/respond --pr <n> --repo <owner\/name>/);
  });
});

describe("gardener respond -- snapshot mode", () => {
  it("reads from BREEZE_SNAPSHOT_DIR when set and does not call gh api", async () => {
    const tmp = useTmpDir();
    const snapshotDir = join(tmp.path, "snap");
    mkdirSync(snapshotDir, { recursive: true });
    const prView = {
      number: 42,
      title: "sync: paperclip #3001",
      headRefName: "first-tree/sync-42",
      reviewDecision: "CHANGES_REQUESTED",
      body: "body with <!-- gardener:sync · source_pr=3001 · source_repo=paperclipai/paperclip -->",
      updatedAt: "2026-04-15T00:00:00Z",
    };
    writeFileSync(join(snapshotDir, "pr-view.json"), JSON.stringify(prView));
    writeFileSync(
      join(snapshotDir, "pr-reviews.json"),
      JSON.stringify([
        {
          user: { login: "bingran-you" },
          state: "CHANGES_REQUESTED",
          body: "fix this",
          submitted_at: "2026-04-15T10:00:00Z",
        },
      ]),
    );
    writeFileSync(
      join(snapshotDir, "issue-comments.json"),
      JSON.stringify([]),
    );
    writeFileSync(join(snapshotDir, "pr.diff"), "diff --git a b\n");

    const calls: ShellCall[] = [];
    const shell = makeShell(
      [
        (call) => {
          // Expect only `gh pr edit` and `gh pr comment` — NOT api fetches.
          if (call.command === "gh" && call.args[0] === "api") {
            throw new Error(`unexpected gh api call: ${call.args.join(" ")}`);
          }
          return { stdout: "", stderr: "", code: 0 };
        },
      ],
      calls,
    );
    const { write, lines } = captureWrite();
    const code = await runRespond(
      ["--pr", "42", "--repo", "owner/name", "--tree-path", tmp.path],
      {
        shellRun: shell,
        write,
        env: { BREEZE_SNAPSHOT_DIR: snapshotDir },
        now: () => new Date("2026-04-16T00:00:00Z"),
      },
    );
    expect(code).toBe(0);
    const apiCalls = calls.filter(
      (c) => c.command === "gh" && c.args[0] === "api",
    );
    expect(apiCalls).toHaveLength(0);
    expect(lines[lines.length - 1]).toMatch(/^BREEZE_RESULT: /);
  });

  it("skips without double-bumping attempts when pr-commits.json shows the fix is already pushed (regression #158)", async () => {
    const tmp = useTmpDir();
    const snapshotDir = join(tmp.path, "snap");
    mkdirSync(snapshotDir, { recursive: true });
    const prView = {
      number: 55,
      title: "sync: something",
      headRefName: "first-tree/sync-55",
      reviewDecision: "CHANGES_REQUESTED",
      body: "plain body",
      updatedAt: "2026-04-15T00:00:00Z",
    };
    writeFileSync(join(snapshotDir, "pr-view.json"), JSON.stringify(prView));
    writeFileSync(
      join(snapshotDir, "pr-reviews.json"),
      JSON.stringify([
        {
          user: { login: "bingran-you" },
          state: "CHANGES_REQUESTED",
          body: "fix this",
          submitted_at: "2026-04-15T10:00:00Z",
        },
      ]),
    );
    writeFileSync(
      join(snapshotDir, "issue-comments.json"),
      JSON.stringify([]),
    );
    writeFileSync(join(snapshotDir, "pr.diff"), "");
    // Latest commit is AFTER the CHANGES_REQUESTED review — simulates a
    // duplicate dispatch (retry/webhook redelivery/crash recovery) after
    // the first respond already pushed a fix.
    writeFileSync(
      join(snapshotDir, "pr-commits.json"),
      JSON.stringify([
        {
          commit: {
            committer: { date: "2026-04-15T10:30:00Z" },
          },
        },
      ]),
    );

    const calls: ShellCall[] = [];
    const shell = makeShell(
      [() => ({ stdout: "", stderr: "", code: 0 })],
      calls,
    );
    const { write, lines } = captureWrite();
    const code = await runRespond(
      ["--pr", "55", "--repo", "owner/name", "--tree-path", tmp.path],
      {
        shellRun: shell,
        write,
        env: { BREEZE_SNAPSHOT_DIR: snapshotDir },
        now: () => new Date("2026-04-16T00:00:00Z"),
      },
    );
    expect(code).toBe(0);
    const last = lines[lines.length - 1];
    expect(last).toMatch(
      /^BREEZE_RESULT: status=skipped summary=already fixed/,
    );
    // No attempts bump and no duplicate reply: neither `gh pr edit` nor
    // `gh pr comment` should have fired.
    const writes = calls.filter(
      (c) =>
        c.command === "gh" &&
        c.args[0] === "pr" &&
        (c.args[1] === "edit" || c.args[1] === "comment"),
    );
    expect(writes).toHaveLength(0);
  });

  it("still proceeds when pr-commits.json shows the latest commit predates the review", async () => {
    const tmp = useTmpDir();
    const snapshotDir = join(tmp.path, "snap");
    mkdirSync(snapshotDir, { recursive: true });
    const prView = {
      number: 56,
      title: "sync: something",
      headRefName: "first-tree/sync-56",
      reviewDecision: "CHANGES_REQUESTED",
      body: "plain body",
      updatedAt: "2026-04-15T00:00:00Z",
    };
    writeFileSync(join(snapshotDir, "pr-view.json"), JSON.stringify(prView));
    writeFileSync(
      join(snapshotDir, "pr-reviews.json"),
      JSON.stringify([
        {
          user: { login: "bingran-you" },
          state: "CHANGES_REQUESTED",
          body: "fix this",
          submitted_at: "2026-04-15T10:00:00Z",
        },
      ]),
    );
    writeFileSync(
      join(snapshotDir, "issue-comments.json"),
      JSON.stringify([]),
    );
    writeFileSync(join(snapshotDir, "pr.diff"), "");
    // Latest commit is BEFORE the review — the fix hasn't been pushed yet.
    writeFileSync(
      join(snapshotDir, "pr-commits.json"),
      JSON.stringify([
        {
          commit: {
            committer: { date: "2026-04-14T10:00:00Z" },
          },
        },
      ]),
    );

    const calls: ShellCall[] = [];
    const shell = makeShell(
      [() => ({ stdout: "", stderr: "", code: 0 })],
      calls,
    );
    const { write, lines } = captureWrite();
    const code = await runRespond(
      ["--pr", "56", "--repo", "owner/name", "--tree-path", tmp.path],
      {
        shellRun: shell,
        write,
        env: { BREEZE_SNAPSHOT_DIR: snapshotDir },
        now: () => new Date("2026-04-16T00:00:00Z"),
      },
    );
    expect(code).toBe(0);
    expect(lines[lines.length - 1]).toMatch(
      /^BREEZE_RESULT: status=handled/,
    );
    const edits = calls.filter(
      (c) => c.command === "gh" && c.args[0] === "pr" && c.args[1] === "edit",
    );
    expect(edits.length).toBeGreaterThan(0);
  });

  it("calls gh when BREEZE_SNAPSHOT_DIR is unset", async () => {
    const tmp = useTmpDir();
    const calls: ShellCall[] = [];
    const shell = makeShell(
      [
        (call) => {
          if (call.command === "gh" && call.args[0] === "pr" && call.args[1] === "view") {
            return {
              stdout: JSON.stringify({
                number: 7,
                title: "sync",
                headRefName: "first-tree/sync-7",
                reviewDecision: "CHANGES_REQUESTED",
                body: "body",
                labels: [{ name: "first-tree:sync" }],
                updatedAt: "2026-04-15T00:00:00Z",
              }),
              stderr: "",
              code: 0,
            };
          }
          if (call.command === "gh" && call.args[0] === "api") {
            return { stdout: "[]", stderr: "", code: 0 };
          }
          if (call.command === "gh" && call.args[0] === "pr" && call.args[1] === "diff") {
            return { stdout: "", stderr: "", code: 0 };
          }
          if (call.command === "gh" && call.args[0] === "pr" && call.args[1] === "edit") {
            return { stdout: "", stderr: "", code: 0 };
          }
          if (call.command === "gh" && call.args[0] === "pr" && call.args[1] === "comment") {
            return { stdout: "", stderr: "", code: 0 };
          }
          return null;
        },
      ],
      calls,
    );
    const { write } = captureWrite();
    const code = await runRespond(
      ["--pr", "7", "--repo", "owner/name", "--tree-path", tmp.path],
      {
        shellRun: shell,
        write,
        env: {}, // snapshot dir unset
        now: () => new Date("2026-04-16T00:00:00Z"),
      },
    );
    expect(code).toBe(0);
    const prViewCalls = calls.filter(
      (c) => c.command === "gh" && c.args[0] === "pr" && c.args[1] === "view",
    );
    expect(prViewCalls.length).toBeGreaterThan(0);
  });
});

describe("gardener respond -- attempts counter", () => {
  it("reads the attempts marker from a PR body", () => {
    expect(
      readRespondAttempts("hello\n<!-- gardener:respond-attempts=3 -->\n"),
    ).toBe(3);
    expect(readRespondAttempts("no marker")).toBe(0);
    expect(readRespondAttempts(undefined)).toBe(0);
  });

  it("writes the attempts marker into a body idempotently", () => {
    const withMarker = writeRespondAttempts(
      "body\n<!-- gardener:respond-attempts=1 -->\n",
      2,
    );
    expect(withMarker).toContain("<!-- gardener:respond-attempts=2 -->");
    expect(readRespondAttempts(withMarker)).toBe(2);

    const freshBody = writeRespondAttempts("plain body", 1);
    expect(freshBody).toContain("<!-- gardener:respond-attempts=1 -->");
  });

  it("labels breeze:human and skips once attempts hit the max", async () => {
    const tmp = useTmpDir();
    const snapshotDir = join(tmp.path, "snap");
    mkdirSync(snapshotDir, { recursive: true });
    const prView = {
      number: 99,
      title: "sync",
      headRefName: "first-tree/sync-99",
      reviewDecision: "CHANGES_REQUESTED",
      body: `body <!-- gardener:respond-attempts=${RESPOND_MAX_ATTEMPTS} -->`,
      updatedAt: "2026-04-15T00:00:00Z",
    };
    writeFileSync(join(snapshotDir, "pr-view.json"), JSON.stringify(prView));
    writeFileSync(
      join(snapshotDir, "pr-reviews.json"),
      JSON.stringify([
        {
          user: { login: "bingran-you" },
          state: "CHANGES_REQUESTED",
          body: "still broken",
          submitted_at: "2026-04-15T10:00:00Z",
        },
      ]),
    );
    writeFileSync(join(snapshotDir, "issue-comments.json"), JSON.stringify([]));
    writeFileSync(join(snapshotDir, "pr.diff"), "");

    const calls: ShellCall[] = [];
    const shell = makeShell(
      [() => ({ stdout: "", stderr: "", code: 0 })],
      calls,
    );
    const { write, lines } = captureWrite();
    const code = await runRespond(
      ["--pr", "99", "--repo", "owner/name", "--tree-path", tmp.path],
      {
        shellRun: shell,
        write,
        env: { BREEZE_SNAPSHOT_DIR: snapshotDir },
        now: () => new Date("2026-04-16T00:00:00Z"),
      },
    );
    expect(code).toBe(0);
    const labelCall = calls.find(
      (c) =>
        c.command === "gh" &&
        c.args[0] === "pr" &&
        c.args[1] === "edit" &&
        c.args.includes("breeze:human"),
    );
    expect(labelCall).toBeDefined();
    expect(
      lines.some((l) => l.includes("max attempts reached") || l.includes("respond attempts reached")),
    ).toBe(true);
    // When the cap is hit we must NOT bump the attempts marker or post a
    // new "attempt N/5" comment — only add the breeze:human label.
    const bodyEdit = calls.find(
      (c) =>
        c.command === "gh" &&
        c.args[0] === "pr" &&
        c.args[1] === "edit" &&
        c.args.includes("--body"),
    );
    expect(bodyEdit).toBeUndefined();
    const comment = calls.find(
      (c) =>
        c.command === "gh" && c.args[0] === "pr" && c.args[1] === "comment",
    );
    expect(comment).toBeUndefined();
  });
});

describe("gardener respond -- idempotency", () => {
  it("skips when the latest commit is newer than the latest CHANGES_REQUESTED review", async () => {
    const tmp = useTmpDir();
    const calls: ShellCall[] = [];
    const shell = makeShell(
      [
        (call) => {
          if (call.command === "gh" && call.args[0] === "pr" && call.args[1] === "view") {
            return {
              stdout: JSON.stringify({
                number: 11,
                title: "sync",
                headRefName: "first-tree/sync-11",
                reviewDecision: "CHANGES_REQUESTED",
                body: "plain",
                updatedAt: "2026-04-15T00:00:00Z",
              }),
              stderr: "",
              code: 0,
            };
          }
          if (
            call.command === "gh" &&
            call.args[0] === "api" &&
            call.args[1].includes("/reviews")
          ) {
            return {
              stdout: JSON.stringify([
                {
                  user: { login: "bingran-you" },
                  state: "CHANGES_REQUESTED",
                  submitted_at: "2026-04-15T10:00:00Z",
                },
              ]),
              stderr: "",
              code: 0,
            };
          }
          if (
            call.command === "gh" &&
            call.args[0] === "api" &&
            call.args[1].includes("/issues/") &&
            call.args[1].endsWith("/comments")
          ) {
            return { stdout: "[]", stderr: "", code: 0 };
          }
          if (
            call.command === "gh" &&
            call.args[0] === "api" &&
            call.args[1].includes("/commits")
          ) {
            return {
              stdout: "2026-04-15T12:00:00Z\n",
              stderr: "",
              code: 0,
            };
          }
          if (call.command === "gh" && call.args[0] === "pr" && call.args[1] === "diff") {
            return { stdout: "", stderr: "", code: 0 };
          }
          return null;
        },
      ],
      calls,
    );
    const { write, lines } = captureWrite();
    const code = await runRespond(
      ["--pr", "11", "--repo", "owner/name", "--tree-path", tmp.path],
      {
        shellRun: shell,
        write,
        env: {},
        now: () => new Date("2026-04-16T00:00:00Z"),
      },
    );
    expect(code).toBe(0);
    expect(
      lines.some((l) => l.includes("already pushed")) ||
        lines.some((l) => l.includes("waiting for re-review")),
    ).toBe(true);
    // No pr edit / comment should have been issued.
    const writes = calls.filter(
      (c) =>
        c.command === "gh" &&
        c.args[0] === "pr" &&
        (c.args[1] === "edit" || c.args[1] === "comment"),
    );
    expect(writes).toHaveLength(0);
  });
});

describe("gardener respond -- helpers", () => {
  it("classifies review decisions", () => {
    expect(
      classifyReviewDecision(
        { number: 1, reviewDecision: "APPROVED" } as never,
        false,
      ),
    ).toBe("approved");
    expect(
      classifyReviewDecision(
        { number: 1, reviewDecision: "CHANGES_REQUESTED" } as never,
        false,
      ),
    ).toBe("changes_requested");
    expect(
      classifyReviewDecision({ number: 1 } as never, true),
    ).toBe("changes_requested");
    expect(
      classifyReviewDecision(
        { number: 1, title: "housekeeping: weekly" } as never,
        false,
      ),
    ).toBe("housekeeping");
    expect(classifyReviewDecision({ number: 1 } as never, false)).toBe("none");
  });

  it("recognises sync PRs by branch or label", () => {
    expect(
      isSyncPr({ number: 1, headRefName: "first-tree/sync-abc" }),
    ).toBe(true);
    expect(
      hasSyncLabel({
        number: 1,
        labels: [{ name: "first-tree:sync" }],
      } as never),
    ).toBe(true);
    expect(isSyncPr({ number: 1, headRefName: "feature/x" })).toBe(false);
  });

  it("also recognises draft-node PRs as respondable (#307)", () => {
    // draft-node writes branches like `first-tree/draft-node-<proposal_id>`.
    // respond needs to accept them so the issue → draft-node → PR → respond
    // chain actually connects.
    expect(
      isSyncPr({
        number: 1,
        headRefName: "first-tree/draft-node-19aeb0ab73f4",
      }),
    ).toBe(true);
  });

  it("extracts source PR metadata from the body marker", () => {
    const body =
      "<!-- gardener:sync · source_pr=3001 · source_repo=paperclipai/paperclip -->";
    const info = extractSourcePr(body);
    expect(info?.sourcePr).toBe(3001);
    expect(info?.sourceRepo).toContain("paperclip");
    expect(extractSourcePr("no marker")).toBeNull();
  });

  it("extracts source repo slugs that contain hyphens", () => {
    const body =
      "<!-- gardener:sync · source_pr=42 · source_repo=agent-team-foundation/first-tree -->";
    const info = extractSourcePr(body);
    expect(info?.sourcePr).toBe(42);
    expect(info?.sourceRepo).toBe("agent-team-foundation/first-tree");
  });

  it("finds the latest CHANGES_REQUESTED review timestamp", () => {
    expect(
      latestChangesRequestedAt([
        { state: "APPROVED", submitted_at: "2026-04-16T00:00:00Z" },
        {
          state: "CHANGES_REQUESTED",
          submitted_at: "2026-04-15T00:00:00Z",
        },
        {
          state: "CHANGES_REQUESTED",
          submitted_at: "2026-04-15T12:00:00Z",
        },
      ]),
    ).toBe("2026-04-15T12:00:00Z");
    expect(latestChangesRequestedAt([])).toBeNull();
  });

  it("readSnapshot returns null when pr-view.json is missing", () => {
    const tmp = useTmpDir();
    expect(readSnapshot(tmp.path)).toBeNull();
  });

  it("latestCommitTimeFromCommits picks the max committer/author date", () => {
    expect(
      latestCommitTimeFromCommits([
        { commit: { committer: { date: "2026-04-15T10:00:00Z" } } },
        { commit: { committer: { date: "2026-04-15T11:00:00Z" } } },
        { commit: { author: { date: "2026-04-15T09:00:00Z" } } },
      ]),
    ).toBe("2026-04-15T11:00:00Z");
    expect(latestCommitTimeFromCommits([])).toBeNull();
    expect(latestCommitTimeFromCommits([{ commit: {} }])).toBeNull();
  });

  it("readSnapshot populates latestCommitTime from pr-commits.json", () => {
    const tmp = useTmpDir();
    writeFileSync(
      join(tmp.path, "pr-view.json"),
      JSON.stringify({ number: 1 }),
    );
    writeFileSync(
      join(tmp.path, "pr-commits.json"),
      JSON.stringify([
        { commit: { committer: { date: "2026-04-15T10:00:00Z" } } },
        { commit: { committer: { date: "2026-04-15T12:00:00Z" } } },
      ]),
    );
    const bundle = readSnapshot(tmp.path);
    expect(bundle?.latestCommitTime).toBe("2026-04-15T12:00:00Z");
  });

  it("readSnapshot returns latestCommitTime=null when pr-commits.json is missing", () => {
    const tmp = useTmpDir();
    writeFileSync(
      join(tmp.path, "pr-view.json"),
      JSON.stringify({ number: 1 }),
    );
    const bundle = readSnapshot(tmp.path);
    expect(bundle?.latestCommitTime).toBeNull();
  });
});

describe("gardener respond -- isFromGardener helper", () => {
  it("matches by login when gardenerLogin is set", () => {
    expect(
      isFromGardener(
        { user: { login: "serenakeyitan" }, body: "plain text" },
        "serenakeyitan",
      ),
    ).toBe(true);
    expect(
      isFromGardener(
        { user: { login: "someone-else" }, body: "plain text" },
        "serenakeyitan",
      ),
    ).toBe(false);
  });

  it("falls back to HTML marker when login is empty or differs", () => {
    // Marker present, login empty → still treated as gardener.
    expect(
      isFromGardener(
        {
          user: { login: "bot-identity" },
          body: "looks good <!-- gardener:sync · source_pr=1 -->",
        },
        "",
      ),
    ).toBe(true);
    // Marker present, login differs from gardenerLogin → still gardener.
    expect(
      isFromGardener(
        {
          user: { login: "different-bot" },
          body: "<!-- gardener:review-pass -->",
        },
        "serenakeyitan",
      ),
    ).toBe(true);
    // No marker, no login match → not gardener.
    expect(
      isFromGardener(
        { user: { login: "bingran-you" }, body: "please fix" },
        "serenakeyitan",
      ),
    ).toBe(false);
  });
});

describe("gardener respond -- self-loop guard", () => {
  it("skips when the only CHANGES_REQUESTED review is from gardener itself", async () => {
    const tmp = useTmpDir();
    const snapshotDir = join(tmp.path, "snap");
    mkdirSync(snapshotDir, { recursive: true });
    const prView = {
      number: 201,
      title: "sync: something",
      headRefName: "first-tree/sync-201",
      reviewDecision: "CHANGES_REQUESTED",
      body: "plain body",
      updatedAt: "2026-04-15T00:00:00Z",
    };
    writeFileSync(join(snapshotDir, "pr-view.json"), JSON.stringify(prView));
    writeFileSync(
      join(snapshotDir, "pr-reviews.json"),
      JSON.stringify([
        {
          user: { login: "serenakeyitan" },
          state: "CHANGES_REQUESTED",
          body: "<!-- gardener:review-pass -->\nstructural check\n",
          submitted_at: "2026-04-15T10:00:00Z",
        },
      ]),
    );
    writeFileSync(join(snapshotDir, "issue-comments.json"), JSON.stringify([]));
    writeFileSync(join(snapshotDir, "pr.diff"), "");

    const calls: ShellCall[] = [];
    const shell = makeShell(
      [() => ({ stdout: "", stderr: "", code: 0 })],
      calls,
    );
    const { write, lines } = captureWrite();
    const code = await runRespond(
      ["--pr", "201", "--repo", "owner/name", "--tree-path", tmp.path],
      {
        shellRun: shell,
        write,
        env: {
          BREEZE_SNAPSHOT_DIR: snapshotDir,
          GARDENER_LOGIN: "serenakeyitan",
        },
        now: () => new Date("2026-04-16T00:00:00Z"),
      },
    );
    expect(code).toBe(0);
    expect(
      lines.some((l) => l.includes("no non-gardener feedback")),
    ).toBe(true);
    const last = lines[lines.length - 1];
    expect(last).toMatch(/^BREEZE_RESULT: status=skipped summary=no non-gardener feedback/);
    // No gh pr edit / gh pr comment / git commit should have fired.
    const writes = calls.filter(
      (c) =>
        (c.command === "gh" &&
          c.args[0] === "pr" &&
          (c.args[1] === "edit" || c.args[1] === "comment")) ||
        c.command === "git",
    );
    expect(writes).toHaveLength(0);
  });

  it("proceeds when at least one non-gardener CHANGES_REQUESTED review exists", async () => {
    const tmp = useTmpDir();
    const snapshotDir = join(tmp.path, "snap");
    mkdirSync(snapshotDir, { recursive: true });
    const prView = {
      number: 202,
      title: "sync: something",
      headRefName: "first-tree/sync-202",
      reviewDecision: "CHANGES_REQUESTED",
      body: "plain body",
      updatedAt: "2026-04-15T00:00:00Z",
    };
    writeFileSync(join(snapshotDir, "pr-view.json"), JSON.stringify(prView));
    writeFileSync(
      join(snapshotDir, "pr-reviews.json"),
      JSON.stringify([
        {
          user: { login: "serenakeyitan" },
          state: "CHANGES_REQUESTED",
          body: "<!-- gardener:review-pass -->",
          submitted_at: "2026-04-15T10:00:00Z",
        },
        {
          user: { login: "human-reviewer" },
          state: "CHANGES_REQUESTED",
          body: "please also rename the helper",
          submitted_at: "2026-04-15T11:00:00Z",
        },
      ]),
    );
    writeFileSync(join(snapshotDir, "issue-comments.json"), JSON.stringify([]));
    writeFileSync(join(snapshotDir, "pr.diff"), "");

    const calls: ShellCall[] = [];
    const shell = makeShell(
      [() => ({ stdout: "", stderr: "", code: 0 })],
      calls,
    );
    const { write, lines } = captureWrite();
    const code = await runRespond(
      ["--pr", "202", "--repo", "owner/name", "--tree-path", tmp.path],
      {
        shellRun: shell,
        write,
        env: {
          BREEZE_SNAPSHOT_DIR: snapshotDir,
          GARDENER_LOGIN: "serenakeyitan",
        },
        now: () => new Date("2026-04-16T00:00:00Z"),
      },
    );
    expect(code).toBe(0);
    expect(
      lines.some((l) => l.includes("no non-gardener feedback")),
    ).toBe(false);
    // Normal fix path fires a pr edit (attempts counter) + pr comment.
    const editCall = calls.find(
      (c) => c.command === "gh" && c.args[0] === "pr" && c.args[1] === "edit",
    );
    const commentCall = calls.find(
      (c) => c.command === "gh" && c.args[0] === "pr" && c.args[1] === "comment",
    );
    expect(editCall).toBeDefined();
    expect(commentCall).toBeDefined();
  });

  it("skips when the only @gardener fix comment was posted by gardener itself", async () => {
    const tmp = useTmpDir();
    const snapshotDir = join(tmp.path, "snap");
    mkdirSync(snapshotDir, { recursive: true });
    const prView = {
      number: 203,
      title: "sync: something",
      headRefName: "first-tree/sync-203",
      // Note: reviewDecision is NOT CHANGES_REQUESTED here — the only
      // reason respond would otherwise act is the @gardener fix mention.
      reviewDecision: "",
      body: "plain body",
      updatedAt: "2026-04-15T00:00:00Z",
    };
    writeFileSync(join(snapshotDir, "pr-view.json"), JSON.stringify(prView));
    writeFileSync(join(snapshotDir, "pr-reviews.json"), JSON.stringify([]));
    writeFileSync(
      join(snapshotDir, "issue-comments.json"),
      JSON.stringify([
        {
          user: { login: "serenakeyitan" },
          body:
            "<!-- gardener:sync -->\nping @gardener fix (self-reminder)\n",
          created_at: "2026-04-15T10:00:00Z",
        },
      ]),
    );
    writeFileSync(join(snapshotDir, "pr.diff"), "");

    const calls: ShellCall[] = [];
    const shell = makeShell(
      [() => ({ stdout: "", stderr: "", code: 0 })],
      calls,
    );
    const { write, lines } = captureWrite();
    const code = await runRespond(
      ["--pr", "203", "--repo", "owner/name", "--tree-path", tmp.path],
      {
        shellRun: shell,
        write,
        env: {
          BREEZE_SNAPSHOT_DIR: snapshotDir,
          GARDENER_LOGIN: "serenakeyitan",
        },
        now: () => new Date("2026-04-16T00:00:00Z"),
      },
    );
    expect(code).toBe(0);
    expect(
      lines.some((l) => l.includes("no non-gardener feedback")),
    ).toBe(true);
    // No writes to the PR.
    const writes = calls.filter(
      (c) =>
        c.command === "gh" &&
        c.args[0] === "pr" &&
        (c.args[1] === "edit" || c.args[1] === "comment"),
    );
    expect(writes).toHaveLength(0);
  });
});
