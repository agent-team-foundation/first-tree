import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { GARDENER_USAGE, runGardener } from "#products/gardener/cli.js";
import {
  assigneesFromMentions,
  buildCommentBody,
  buildTreeIssueBody,
  codeownersForPath,
  collectTargetRepos,
  COMMENT_USAGE,
  commentLogPath,
  defaultClassifier,
  extractStateMarker,
  GARDENER_COMMAND_RE,
  GARDENER_IGNORED_MARKER_RE,
  GARDENER_STATE_MARKER_RE,
  hasIgnoredMarker,
  hasPausedMarker,
  hasReviewedLabel,
  parseStateMarker,
  readLastConsumedRereview,
  readSnapshot,
  resolveMergedSinceISO,
  resolveState,
  runComment,
  shaMatches,
  withTreeIssueCreatedField,
  withQuietRefreshCid,
  QUIET_REFRESH_CID_MARKER_RE,
  QUIET_REFRESH_CID_PLACEHOLDER,
  type Classifier,
  type ShellResult,
  type ShellRun,
} from "#products/gardener/engine/comment.js";
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
    return {
      stdout: "",
      stderr: `no mock for ${command} ${args.join(" ")}`,
      code: 1,
    };
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

const alignedClassifier: Classifier = async () => ({
  verdict: "ALIGNED",
  severity: "low",
  summary: "Fits the V1 scope decision.",
  treeNodes: [{ path: "product/NODE.md", summary: "V1 scope summary" }],
});

const conflictClassifier: Classifier = async () => ({
  verdict: "CONFLICT",
  severity: "high",
  summary: "Contradicts the thin-core decision.",
  treeNodes: [{ path: "product/NODE.md", summary: "thin core principle" }],
});

// ─────────────────── 1. opt-out ───────────────────
describe("gardener comment -- config opt-out", () => {
  it("exits 0 with opt-out message and does not call gh", async () => {
    const tmp = useTmpDir();
    writeConfig(tmp.path, "modules:\n  comment:\n    enabled: false\n");
    const calls: ShellCall[] = [];
    const shell = makeShell([], calls);
    const { write, lines } = captureWrite();
    const code = await runComment(
      ["--tree-path", tmp.path],
      {
        shellRun: shell,
        write,
        env: {},
        now: () => new Date("2026-04-16T00:00:00Z"),
        classifier: alignedClassifier,
      },
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    const joined = lines.join("\n");
    expect(joined).toContain("gardener-comment is disabled via .claude/gardener-config.yaml");
    expect(lines[lines.length - 1]).toMatch(/^BREEZE_RESULT: status=skipped /);
  });
});

// ─────────────────── 1b. no classifier injected ───────────────────
describe("gardener comment -- no classifier injected", () => {
  it("skips with a clear message instead of posting INSUFFICIENT_CONTEXT spam", async () => {
    const tmp = useTmpDir();
    writeConfig(tmp.path, "tree_repo: o/tree\ntarget_repo: o/src\n");
    const calls: ShellCall[] = [];
    const shell = makeShell([], calls);
    const { write, lines } = captureWrite();
    const code = await runComment(
      ["--pr", "1", "--repo", "o/src", "--tree-path", tmp.path],
      {
        shellRun: shell,
        write,
        env: {},
        // no classifier — simulate the stock CLI path
      },
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    const joined = lines.join("\n");
    expect(joined).toContain("no classifier injected");
    expect(lines[lines.length - 1]).toMatch(
      /^BREEZE_RESULT: status=skipped summary=no classifier injected/,
    );
  });

  it("also skips the scan path (no target_repo hits gh)", async () => {
    const tmp = useTmpDir();
    writeConfig(
      tmp.path,
      "tree_repo: o/tree\ntarget_repos:\n  - o/a\n  - o/b\n",
    );
    const calls: ShellCall[] = [];
    const shell = makeShell([], calls);
    const { write, lines } = captureWrite();
    const code = await runComment(["--tree-path", tmp.path], {
      shellRun: shell,
      write,
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(lines[lines.length - 1]).toMatch(
      /^BREEZE_RESULT: status=skipped summary=no classifier injected/,
    );
  });
});

// ─────────────────── 2. --help ───────────────────
describe("gardener comment -- --help", () => {
  it("prints COMMENT_USAGE", async () => {
    const { write, lines } = captureWrite();
    const code = await runComment(["--help"], { write });
    expect(code).toBe(0);
    const joined = lines.join("\n");
    expect(joined).toContain(COMMENT_USAGE);
    expect(lines[lines.length - 1]).toMatch(/^BREEZE_RESULT: /);
  });
});

// ─────────────────── 3. CLI dispatch ───────────────────
describe("gardener CLI dispatch -- comment subcommand", () => {
  it("runGardener(['comment', '--help']) prints COMMENT_USAGE", async () => {
    const { write, lines } = captureWrite();
    const code = await runGardener(["comment", "--help"], write);
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain(COMMENT_USAGE);
  });

  it("runCli dispatches gardener comment --help", async () => {
    const { write, lines } = captureWrite();
    const code = await runCli(["gardener", "comment", "--help"], write);
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain(COMMENT_USAGE);
  });

  it("GARDENER_USAGE lists the comment command", () => {
    expect(GARDENER_USAGE).toContain("comment");
    expect(GARDENER_USAGE).toContain("respond");
  });

  it("runGardener wires GARDENER_CLASSIFIER_MODEL into the built-in classifier", async () => {
    const tmp = useTmpDir();
    const snapshotDir = join(tmp.path, "snap");
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(join(tmp.path, "NODE.md"), "---\ndescription: Root\n---\n");
    writeFileSync(
      join(snapshotDir, "pr-view.json"),
      JSON.stringify({
        number: 1,
        title: "t",
        headRefOid: "abcd",
        state: "OPEN",
        author: { login: "u" },
        additions: 1,
        deletions: 0,
        updatedAt: "2026-04-16T00:00:00Z",
      }),
    );
    writeFileSync(join(snapshotDir, "issue-comments.json"), JSON.stringify([]));
    writeFileSync(
      join(snapshotDir, "subject.json"),
      JSON.stringify({ gardenerUser: "repo-gardener", treeSha: "tsha1234" }),
    );
    writeFileSync(join(snapshotDir, "pr.diff"), "");

    const originalFetch = globalThis.fetch;
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    const originalModel = process.env.GARDENER_CLASSIFIER_MODEL;
    const originalSnapshotDir = process.env.BREEZE_SNAPSHOT_DIR;
    const seen: { body?: string } = {};

    try {
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        seen.body = init?.body as string;
        return new Response(
          JSON.stringify({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  verdict: "ALIGNED",
                  severity: "low",
                  summary: "ok",
                  treeNodes: [],
                }),
              },
            ],
          }),
          { status: 200 },
        );
      }) as typeof fetch;
      process.env.ANTHROPIC_API_KEY = "sk-test";
      process.env.GARDENER_CLASSIFIER_MODEL = "claude-sonnet-4-6";
      process.env.BREEZE_SNAPSHOT_DIR = snapshotDir;

      const { write, lines } = captureWrite();
      const code = await runGardener(
        [
          "comment",
          "--pr",
          "1",
          "--repo",
          "o/r",
          "--tree-path",
          tmp.path,
          "--dry-run",
        ],
        write,
      );

      expect(code).toBe(0);
      expect(lines[lines.length - 1]).toMatch(/^BREEZE_RESULT: /);
      const parsed = JSON.parse(seen.body ?? "{}");
      expect(parsed.model).toBe("claude-sonnet-4-6");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalApiKey;
      if (originalModel === undefined) delete process.env.GARDENER_CLASSIFIER_MODEL;
      else process.env.GARDENER_CLASSIFIER_MODEL = originalModel;
      if (originalSnapshotDir === undefined) delete process.env.BREEZE_SNAPSHOT_DIR;
      else process.env.BREEZE_SNAPSHOT_DIR = originalSnapshotDir;
    }
  });

  it("runGardener treats blank GARDENER_CLASSIFIER_MODEL as unset", async () => {
    const tmp = useTmpDir();
    const snapshotDir = join(tmp.path, "snap");
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(join(tmp.path, "NODE.md"), "---\ndescription: Root\n---\n");
    writeFileSync(
      join(snapshotDir, "pr-view.json"),
      JSON.stringify({
        number: 1,
        title: "t",
        headRefOid: "abcd",
        state: "OPEN",
        author: { login: "u" },
        additions: 1,
        deletions: 0,
        updatedAt: "2026-04-16T00:00:00Z",
      }),
    );
    writeFileSync(join(snapshotDir, "issue-comments.json"), JSON.stringify([]));
    writeFileSync(
      join(snapshotDir, "subject.json"),
      JSON.stringify({ gardenerUser: "repo-gardener", treeSha: "tsha1234" }),
    );
    writeFileSync(join(snapshotDir, "pr.diff"), "");

    const originalFetch = globalThis.fetch;
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    const originalModel = process.env.GARDENER_CLASSIFIER_MODEL;
    const originalSnapshotDir = process.env.BREEZE_SNAPSHOT_DIR;
    const seen: { body?: string } = {};

    try {
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        seen.body = init?.body as string;
        return new Response(
          JSON.stringify({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  verdict: "ALIGNED",
                  severity: "low",
                  summary: "ok",
                  treeNodes: [],
                }),
              },
            ],
          }),
          { status: 200 },
        );
      }) as typeof fetch;
      process.env.ANTHROPIC_API_KEY = "sk-test";
      process.env.GARDENER_CLASSIFIER_MODEL = "   ";
      process.env.BREEZE_SNAPSHOT_DIR = snapshotDir;

      const { write, lines } = captureWrite();
      const code = await runGardener(
        [
          "comment",
          "--pr",
          "1",
          "--repo",
          "o/r",
          "--tree-path",
          tmp.path,
          "--dry-run",
        ],
        write,
      );

      expect(code).toBe(0);
      expect(lines[lines.length - 1]).toMatch(/^BREEZE_RESULT: /);
      const parsed = JSON.parse(seen.body ?? "{}");
      expect(parsed.model).toBe("claude-haiku-4-5");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalApiKey;
      if (originalModel === undefined) delete process.env.GARDENER_CLASSIFIER_MODEL;
      else process.env.GARDENER_CLASSIFIER_MODEL = originalModel;
      if (originalSnapshotDir === undefined) delete process.env.BREEZE_SNAPSHOT_DIR;
      else process.env.BREEZE_SNAPSHOT_DIR = originalSnapshotDir;
    }
  });
});

// ─────────────────── 4. state resolution ───────────────────
describe("gardener comment -- state resolution", () => {
  const gardenerUser = "repo-gardener";

  it("ignored marker → skip forever", () => {
    const action = resolveState({
      comments: [
        {
          id: 1,
          user: { login: gardenerUser },
          body:
            "<!-- gardener:state · reviewed=abc -->\n<!-- gardener:ignored -->",
          created_at: "2026-04-15T00:00:00Z",
        },
      ],
      gardenerUser,
      headIdentifier: "xyz",
      hasReviewedLabel: false,
    });
    expect(action.kind).toBe("skip");
    if (action.kind === "skip") {
      expect(action.reason).toContain("ignored");
    }
  });

  it("gardener:state with matching SHA → skip", () => {
    const action = resolveState({
      comments: [
        {
          id: 2,
          user: { login: gardenerUser },
          body:
            "<!-- gardener:state · reviewed=abcdef1234 · verdict=NEEDS_REVIEW · severity=low · tree_sha=t -->",
          created_at: "2026-04-15T00:00:00Z",
        },
      ],
      gardenerUser,
      headIdentifier: "abcdef1234",
      hasReviewedLabel: false,
    });
    expect(action.kind).toBe("skip");
    if (action.kind === "skip") {
      expect(action.reason).toContain("matches head");
    }
  });

  it("gardener:state with different SHA → rereview (PATCH path)", () => {
    const action = resolveState({
      comments: [
        {
          id: 3,
          user: { login: gardenerUser },
          body:
            "<!-- gardener:state · reviewed=oldshaabc · verdict=ALIGNED · severity=low · tree_sha=t -->",
          created_at: "2026-04-15T00:00:00Z",
        },
      ],
      gardenerUser,
      headIdentifier: "newshaxyz",
      hasReviewedLabel: false,
    });
    expect(action.kind).toBe("rereview");
    if (action.kind === "rereview") {
      expect(action.commentId).toBe(3);
    }
  });

  it("gardener:state for issue with matching issue@<iso> → skip (regression guard for #132 review)", () => {
    // Issues store `issue@<iso-timestamp>` in the marker. reviewOne must pass
    // the same form as headIdentifier so shaMatches compares like-for-like.
    // Previously headIdentifier was raw ISO and marker was `issue@<iso>` —
    // shaMatches never matched → every scan re-PATCHed historical issue comments.
    const iso = "2026-04-15T10:00:00Z";
    const action = resolveState({
      comments: [
        {
          id: 7,
          user: { login: gardenerUser },
          body:
            `<!-- gardener:state · reviewed=issue@${iso} · verdict=ALIGNED · severity=low · tree_sha=t -->`,
          created_at: iso,
        },
      ],
      gardenerUser,
      headIdentifier: `issue@${iso}`,
      hasReviewedLabel: false,
    });
    expect(action.kind).toBe("skip");
  });

  it("no marker and no label → first_review", () => {
    const action = resolveState({
      comments: [],
      gardenerUser,
      headIdentifier: "abc",
      hasReviewedLabel: false,
    });
    expect(action.kind).toBe("first_review");
  });

  it("paused marker without resume → skip", () => {
    const action = resolveState({
      comments: [
        {
          id: 10,
          user: { login: gardenerUser },
          body: "<!-- gardener:state · reviewed=abc -->\n<!-- gardener:paused -->",
          created_at: "2026-04-10T00:00:00Z",
        },
        {
          id: 11,
          user: { login: "someone" },
          body: "@gardener pause please",
          created_at: "2026-04-14T00:00:00Z",
        },
      ],
      gardenerUser,
      headIdentifier: "xyz",
      hasReviewedLabel: false,
    });
    expect(action.kind).toBe("skip");
  });

  it("paused marker alone (no surviving pause command) → still skip (regression for #132 review)", () => {
    // User deleted the @gardener pause command after gardener acknowledged it.
    // The marker is the authoritative record — we must still treat as paused.
    const action = resolveState({
      comments: [
        {
          id: 10,
          user: { login: gardenerUser },
          body: "<!-- gardener:state · reviewed=abc -->\n<!-- gardener:paused -->",
          created_at: "2026-04-10T00:00:00Z",
        },
        // No @gardener pause command anywhere.
      ],
      gardenerUser,
      headIdentifier: "xyz",
      hasReviewedLabel: false,
    });
    expect(action.kind).toBe("skip");
    if (action.kind === "skip") expect(action.reason).toContain("paused");
  });

  it("paused marker cleared by newer @gardener resume → fall through (not skipped for paused)", () => {
    const action = resolveState({
      comments: [
        {
          id: 10,
          user: { login: gardenerUser },
          body: "<!-- gardener:state · reviewed=abc -->\n<!-- gardener:paused -->",
          created_at: "2026-04-10T00:00:00Z",
        },
        {
          id: 12,
          user: { login: "someone" },
          body: "@gardener resume",
          created_at: "2026-04-15T00:00:00Z",
        },
      ],
      gardenerUser,
      headIdentifier: "abc", // matches marker → skip for "matches head"
      hasReviewedLabel: false,
    });
    // Should NOT be "skip: paused". It skips for "matches head" (rule 4) since
    // the state marker's SHA equals headIdentifier. That's the fall-through path.
    expect(action.kind).toBe("skip");
    if (action.kind === "skip") {
      expect(action.reason).not.toContain("paused");
    }
  });
});

// ─────────────────── 5. @gardener re-review ───────────────────
describe("gardener comment -- @gardener re-review", () => {
  const gardenerUser = "repo-gardener";

  it("re-review command triggers rereview", () => {
    const action = resolveState({
      comments: [
        {
          id: 20,
          user: { login: gardenerUser },
          body:
            "<!-- gardener:state · reviewed=abc · verdict=ALIGNED · severity=low · tree_sha=t -->\n<!-- gardener:last_consumed_rereview=none -->",
          created_at: "2026-04-10T00:00:00Z",
        },
        {
          id: 21,
          user: { login: "maintainer" },
          body: "@gardener re-review please",
          created_at: "2026-04-14T00:00:00Z",
        },
      ],
      gardenerUser,
      headIdentifier: "abc",
      hasReviewedLabel: false,
    });
    expect(action.kind).toBe("rereview");
    if (action.kind === "rereview") {
      expect(action.consumedRereviewId).toBe(21);
      expect(action.commentId).toBe(20);
    }
  });

  it("excludes self-authored @gardener command text from matching (critical)", () => {
    // Gardener's own comment footer contains the literal
    // "@gardener re-review" text — if resolveState matched it, every
    // run would self-trigger a re-review forever.
    const ownFooterBody =
      "<!-- gardener:state · reviewed=abc · verdict=ALIGNED · severity=low · tree_sha=t -->\n" +
      "Commands: @gardener re-review · @gardener pause · @gardener ignore";
    const action = resolveState({
      comments: [
        {
          id: 30,
          user: { login: gardenerUser },
          body: ownFooterBody,
          created_at: "2026-04-10T00:00:00Z",
        },
      ],
      gardenerUser,
      headIdentifier: "abc",
      hasReviewedLabel: false,
    });
    // Should NOT be rereview — SHA matches and self-footer is ignored.
    expect(action.kind).toBe("skip");
  });

  it("marks re-review as consumed once last_consumed_rereview matches", () => {
    const action = resolveState({
      comments: [
        {
          id: 40,
          user: { login: gardenerUser },
          body:
            "<!-- gardener:state · reviewed=abc · verdict=ALIGNED · severity=low · tree_sha=t -->\n<!-- gardener:last_consumed_rereview=41 -->",
          created_at: "2026-04-14T10:00:00Z",
        },
        {
          id: 41,
          user: { login: "maintainer" },
          body: "@gardener re-review please",
          created_at: "2026-04-14T09:00:00Z",
        },
      ],
      gardenerUser,
      headIdentifier: "abc",
      hasReviewedLabel: false,
    });
    // The re-review #41 has already been consumed — fall through to
    // rule 4. SHA matches, so skip.
    expect(action.kind).toBe("skip");
  });
});

// ─────────────────── 6. verdict classification ───────────────────
describe("gardener comment -- verdict classification", () => {
  it("default classifier returns INSUFFICIENT_CONTEXT/low (semantically honest when no LLM is wired)", async () => {
    const out = await defaultClassifier({
      type: "pr",
      treeRoot: "/tmp",
    });
    // Previously returned NEW_TERRITORY which misrepresented "no judgment
    // made" as "judged this is new". INSUFFICIENT_CONTEXT accurately
    // signals that no real classifier has been wired.
    expect(out.verdict).toBe("INSUFFICIENT_CONTEXT");
    expect(out.severity).toBe("low");
  });

  const verdicts = [
    "ALIGNED",
    "NEW_TERRITORY",
    "NEEDS_REVIEW",
    "CONFLICT",
    "INSUFFICIENT_CONTEXT",
  ] as const;

  it.each(verdicts)("accepts verdict %s from injected classifier", async (v) => {
    const tmp = useTmpDir();
    const snapshotDir = join(tmp.path, "snap");
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(
      join(snapshotDir, "pr-view.json"),
      JSON.stringify({
        number: 1,
        title: "t",
        headRefOid: "abcd",
        state: "OPEN",
        author: { login: "u" },
        additions: 1,
        deletions: 0,
        updatedAt: "2026-04-16T00:00:00Z",
      }),
    );
    writeFileSync(join(snapshotDir, "issue-comments.json"), JSON.stringify([]));
    writeFileSync(
      join(snapshotDir, "subject.json"),
      JSON.stringify({ gardenerUser: "repo-gardener", treeSha: "tsha1234" }),
    );
    writeFileSync(join(snapshotDir, "pr.diff"), "");
    const calls: ShellCall[] = [];
    const shell = makeShell(
      [() => ({ stdout: "", stderr: "", code: 0 })],
      calls,
    );
    const { write, lines } = captureWrite();
    const code = await runComment(
      ["--pr", "1", "--repo", "o/r", "--tree-path", tmp.path],
      {
        shellRun: shell,
        write,
        env: { BREEZE_SNAPSHOT_DIR: snapshotDir },
        now: () => new Date("2026-04-16T00:00:00Z"),
        classifier: async () => ({
          verdict: v,
          severity: v === "CONFLICT" ? "high" : "low",
          summary: `test ${v}`,
          treeNodes: [],
        }),
      },
    );
    expect(code).toBe(0);
    expect(lines[lines.length - 1]).toMatch(/^BREEZE_RESULT: /);
  });
});

// ─────────────────── 7. silent-aligned path ───────────────────
describe("gardener comment -- silent-aligned path", () => {
  it("ALIGNED + low + small PR → label, no POST comment", async () => {
    const tmp = useTmpDir();
    const snapshotDir = join(tmp.path, "snap");
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(
      join(snapshotDir, "pr-view.json"),
      JSON.stringify({
        number: 7,
        title: "small fix",
        headRefOid: "abc123",
        state: "OPEN",
        additions: 5,
        deletions: 2,
        updatedAt: "2026-04-16T00:00:00Z",
      }),
    );
    writeFileSync(join(snapshotDir, "issue-comments.json"), JSON.stringify([]));
    writeFileSync(
      join(snapshotDir, "subject.json"),
      JSON.stringify({ gardenerUser: "repo-gardener" }),
    );
    writeFileSync(join(snapshotDir, "pr.diff"), "");

    const calls: ShellCall[] = [];
    const shell = makeShell(
      [() => ({ stdout: "", stderr: "", code: 0 })],
      calls,
    );
    const { write, lines } = captureWrite();
    const code = await runComment(
      ["--pr", "7", "--repo", "o/r", "--tree-path", tmp.path],
      {
        shellRun: shell,
        write,
        env: { BREEZE_SNAPSHOT_DIR: snapshotDir },
        now: () => new Date("2026-04-16T00:00:00Z"),
        classifier: alignedClassifier,
      },
    );
    expect(code).toBe(0);
    // Should have called `gh pr edit --add-label gardener:reviewed`.
    const labelCalls = calls.filter(
      (c) =>
        c.command === "gh" &&
        c.args[0] === "pr" &&
        c.args[1] === "edit" &&
        c.args.includes("gardener:reviewed"),
    );
    expect(labelCalls.length).toBe(1);
    // Should NOT have POSTed a comment.
    const postCalls = calls.filter(
      (c) =>
        c.command === "gh" &&
        c.args[0] === "api" &&
        c.args.includes("POST") &&
        c.args.some((a) => a.includes("/comments") && !a.includes("comments/")),
    );
    expect(postCalls).toHaveLength(0);
    expect(lines.some((l) => l.includes("silent path"))).toBe(true);
  });

  it("large ALIGNED PR falls through to minimal comment", async () => {
    const tmp = useTmpDir();
    const snapshotDir = join(tmp.path, "snap");
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(
      join(snapshotDir, "pr-view.json"),
      JSON.stringify({
        number: 8,
        title: "large fix",
        headRefOid: "def456",
        state: "OPEN",
        additions: 400,
        deletions: 200,
        updatedAt: "2026-04-16T00:00:00Z",
      }),
    );
    writeFileSync(join(snapshotDir, "issue-comments.json"), JSON.stringify([]));
    writeFileSync(
      join(snapshotDir, "subject.json"),
      JSON.stringify({ gardenerUser: "repo-gardener" }),
    );
    writeFileSync(join(snapshotDir, "pr.diff"), "");

    const calls: ShellCall[] = [];
    const shell = makeShell(
      [() => ({ stdout: "", stderr: "", code: 0 })],
      calls,
    );
    const { write } = captureWrite();
    const code = await runComment(
      ["--pr", "8", "--repo", "o/r", "--tree-path", tmp.path],
      {
        shellRun: shell,
        write,
        env: { BREEZE_SNAPSHOT_DIR: snapshotDir },
        now: () => new Date("2026-04-16T00:00:00Z"),
        classifier: alignedClassifier,
      },
    );
    expect(code).toBe(0);
    const postCalls = calls.filter(
      (c) =>
        c.command === "gh" &&
        c.args[0] === "api" &&
        c.args.includes("POST"),
    );
    expect(postCalls.length).toBeGreaterThan(0);
  });
});

// ─────────────────── 8. comment format ───────────────────
describe("gardener comment -- comment body format", () => {
  it("includes HTML state marker, verdict header, and command footer", () => {
    const body = buildCommentBody({
      verdict: "CONFLICT",
      severity: "high",
      summary: "Contradicts thin-core decision.",
      treeNodes: [
        { path: "product/NODE.md", summary: "thin core principle" },
      ],
      reviewedShort: "abc12345",
      reviewedFull: "abc123451234567890",
      treeSha: "tsha12345678",
      treeShaShort: "tsha1234",
      treeRepoUrl: "https://github.com/acme/tree",
      treeSlug: "acme/tree",
      itemType: "pr",
    });
    expect(body).toContain("<!-- gardener:state ");
    expect(body).toContain("verdict=CONFLICT");
    expect(body).toContain("severity=high");
    expect(body).toContain("gardener:last_consumed_rereview=none");
    expect(body).toContain("@gardener re-review");
    expect(body).toContain("@gardener pause");
    expect(body).toContain("@gardener ignore");
    expect(body).toContain("⚠️");
    expect(body).toContain("acme/tree");
    expect(body).toContain("### Recommendation");
  });

  it("ALIGNED + low comment uses 'No concerns' line and collapsed details", () => {
    const body = buildCommentBody({
      verdict: "ALIGNED",
      severity: "low",
      summary: "Fits V1.",
      treeNodes: [],
      reviewedShort: "abc12345",
      reviewedFull: "abc123451234567890",
      treeSha: "t",
      treeShaShort: "t",
      itemType: "pr",
    });
    expect(body).toContain("No concerns.");
    expect(body).toContain("✅");
    expect(body).not.toContain("### Recommendation");
  });

  it("captures consumedRereviewId in marker line 2", () => {
    const body = buildCommentBody({
      verdict: "ALIGNED",
      severity: "medium",
      summary: "s",
      treeNodes: [],
      reviewedShort: "s",
      reviewedFull: "s",
      treeSha: "t",
      treeShaShort: "t",
      consumedRereviewId: 777,
      itemType: "pr",
    });
    expect(body).toContain("gardener:last_consumed_rereview=777");
  });
});

// ─────────────────── 9. BREEZE_RESULT trailer ───────────────────
describe("gardener comment -- BREEZE_RESULT trailer", () => {
  it("emits on --help", async () => {
    const { write, lines } = captureWrite();
    await runComment(["--help"], { write });
    expect(lines[lines.length - 1]).toMatch(/^BREEZE_RESULT: status=\w+ /);
  });

  it("emits on opt-out", async () => {
    const tmp = useTmpDir();
    writeConfig(tmp.path, "modules:\n  comment:\n    enabled: false\n");
    const { write, lines } = captureWrite();
    await runComment(["--tree-path", tmp.path], {
      write,
      shellRun: makeShell([]),
      env: {},
    });
    expect(lines[lines.length - 1]).toMatch(/^BREEZE_RESULT: status=skipped /);
  });

  it("emits on bad flag", async () => {
    const { write, lines } = captureWrite();
    const code = await runComment(["--nope"], { write, env: {} });
    expect(code).toBe(1);
    expect(lines[lines.length - 1]).toMatch(/^BREEZE_RESULT: status=failed /);
  });

  it("emits on missing --repo", async () => {
    const tmp = useTmpDir();
    const { write, lines } = captureWrite();
    const code = await runComment(
      ["--pr", "1", "--tree-path", tmp.path],
      {
        write,
        env: {},
        shellRun: makeShell([]),
        classifier: alignedClassifier,
      },
    );
    expect(code).toBe(1);
    expect(lines[lines.length - 1]).toMatch(/^BREEZE_RESULT: status=failed /);
  });
});

// ─────────────────── 10. snapshot dir mode ───────────────────
describe("gardener comment -- snapshot mode", () => {
  it("reads from BREEZE_SNAPSHOT_DIR and makes no gh api fetch calls for view/comments", async () => {
    const tmp = useTmpDir();
    const snapshotDir = join(tmp.path, "snap");
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(
      join(snapshotDir, "pr-view.json"),
      JSON.stringify({
        number: 42,
        title: "snap",
        headRefOid: "newsha",
        state: "OPEN",
        additions: 1,
        deletions: 0,
        updatedAt: "2026-04-16T00:00:00Z",
      }),
    );
    writeFileSync(join(snapshotDir, "issue-comments.json"), JSON.stringify([]));
    writeFileSync(
      join(snapshotDir, "subject.json"),
      JSON.stringify({ gardenerUser: "repo-gardener", treeSha: "abc" }),
    );
    writeFileSync(join(snapshotDir, "pr.diff"), "diff");

    const calls: ShellCall[] = [];
    const shell = makeShell(
      [
        (call) => {
          // Guard: snapshot mode must not use gh api to fetch comments
          // or view data via --paginate (writes are allowed: POST/PATCH).
          if (
            call.command === "gh" &&
            call.args[0] === "api" &&
            call.args.includes("--paginate")
          ) {
            throw new Error(
              `snapshot mode leaked gh api fetch: ${call.args.join(" ")}`,
            );
          }
          return { stdout: "", stderr: "", code: 0 };
        },
      ],
      calls,
    );
    const { write, lines } = captureWrite();
    const code = await runComment(
      ["--pr", "42", "--repo", "o/r", "--tree-path", tmp.path],
      {
        shellRun: shell,
        write,
        env: { BREEZE_SNAPSHOT_DIR: snapshotDir },
        now: () => new Date("2026-04-16T00:00:00Z"),
        classifier: conflictClassifier,
      },
    );
    expect(code).toBe(0);
    expect(lines[lines.length - 1]).toMatch(/^BREEZE_RESULT: /);
    // No gh api fetch calls should have happened for view/comments.
    const fetchCalls = calls.filter(
      (c) =>
        c.command === "gh" &&
        c.args[0] === "api" &&
        c.args.some((a) => a.includes("--paginate")),
    );
    expect(fetchCalls).toHaveLength(0);
  });

  it("readSnapshot returns null when pr-view.json/issue-view.json are missing", () => {
    const tmp = useTmpDir();
    expect(readSnapshot(tmp.path)).toBeNull();
  });

  it("readSnapshot returns PR bundle when pr-view.json present", () => {
    const tmp = useTmpDir();
    writeFileSync(
      join(tmp.path, "pr-view.json"),
      JSON.stringify({ number: 1 }),
    );
    writeFileSync(join(tmp.path, "issue-comments.json"), "[]");
    const bundle = readSnapshot(tmp.path);
    expect(bundle?.type).toBe("pr");
    expect(bundle?.prView?.number).toBe(1);
  });

  it("readSnapshot returns issue bundle when only issue-view.json present", () => {
    const tmp = useTmpDir();
    writeFileSync(
      join(tmp.path, "issue-view.json"),
      JSON.stringify({ number: 5 }),
    );
    writeFileSync(join(tmp.path, "issue-comments.json"), "[]");
    const bundle = readSnapshot(tmp.path);
    expect(bundle?.type).toBe("issue");
    expect(bundle?.issueView?.number).toBe(5);
  });
});

// ─────────────────── helpers ───────────────────
describe("gardener comment -- marker helpers", () => {
  it("extractStateMarker captures full HTML comment", () => {
    const body =
      "hello\n<!-- gardener:state · reviewed=abc · verdict=ALIGNED · severity=low · tree_sha=t -->\nworld";
    expect(extractStateMarker(body)).toContain("gardener:state");
  });

  it("parseStateMarker returns reviewed/verdict/severity/treeSha", () => {
    const parsed = parseStateMarker(
      "<!-- gardener:state · reviewed=abcdef · verdict=CONFLICT · severity=high · tree_sha=deadbeef -->",
    );
    expect(parsed?.reviewed).toBe("abcdef");
    expect(parsed?.verdict).toBe("CONFLICT");
    expect(parsed?.severity).toBe("high");
    expect(parsed?.treeSha).toBe("deadbeef");
    expect(parsed?.treeIssueCreated).toBeUndefined();
  });

  it("parseStateMarker extracts tree_issue_created URL when present", () => {
    const parsed = parseStateMarker(
      "<!-- gardener:state · reviewed=abcdef · verdict=NEW_TERRITORY · severity=medium · tree_sha=deadbeef · tree_issue_created=https://github.com/alice/tree/issues/42 -->",
    );
    expect(parsed?.treeIssueCreated).toBe(
      "https://github.com/alice/tree/issues/42",
    );
    expect(parsed?.reviewed).toBe("abcdef");
    expect(parsed?.verdict).toBe("NEW_TERRITORY");
  });

  it("parseStateMarker leaves treeIssueCreated undefined when marker is pre-Phase-1 (backward compat)", () => {
    const parsed = parseStateMarker(
      "<!-- gardener:state · reviewed=abcdef · verdict=ALIGNED · severity=low · tree_sha=deadbeef -->",
    );
    expect(parsed?.treeIssueCreated).toBeUndefined();
  });

  it("parseStateMarker stops URL capture at the marker's ' · ' separator, not mid-URL", () => {
    const parsed = parseStateMarker(
      "<!-- gardener:state · tree_issue_created=https://github.com/alice/tree/issues/7 · reviewed=abcdef -->",
    );
    expect(parsed?.treeIssueCreated).toBe(
      "https://github.com/alice/tree/issues/7",
    );
    expect(parsed?.reviewed).toBe("abcdef");
  });

  it("parseStateMarker ignores non-GitHub URLs in tree_issue_created (markers only carry github.com links)", () => {
    const parsed = parseStateMarker(
      "<!-- gardener:state · reviewed=abc · tree_issue_created=https://evil.example/issues/1 -->",
    );
    expect(parsed?.treeIssueCreated).toBeUndefined();
  });

  it("hasIgnoredMarker / hasPausedMarker detect markers", () => {
    expect(hasIgnoredMarker("<!-- gardener:ignored -->")).toBe(true);
    expect(hasPausedMarker("<!-- gardener:paused -->")).toBe(true);
    expect(hasIgnoredMarker("nothing here")).toBe(false);
    expect(hasPausedMarker(undefined)).toBe(false);
  });

  it("readLastConsumedRereview parses numeric id", () => {
    expect(
      readLastConsumedRereview(
        "<!-- gardener:last_consumed_rereview=12345 -->",
      ),
    ).toBe(12345);
    expect(readLastConsumedRereview("none")).toBeNull();
  });

  it("shaMatches works with prefix (short 8-char vs full 40-char)", () => {
    expect(shaMatches("abcdef1234567890", "abcdef12")).toBe(true);
    expect(shaMatches("abcdef1234567890", "wxyz0000")).toBe(false);
    expect(shaMatches(undefined, "abc")).toBe(false);
    expect(shaMatches("abc", undefined)).toBe(false);
  });

  it("hasReviewedLabel detects gardener:reviewed", () => {
    expect(
      hasReviewedLabel({
        labels: [{ name: "gardener:reviewed" }, { name: "bug" }],
      }),
    ).toBe(true);
    expect(
      hasReviewedLabel({ labels: ["gardener:reviewed"] }),
    ).toBe(true);
    expect(hasReviewedLabel({ labels: [] })).toBe(false);
    expect(hasReviewedLabel(undefined)).toBe(false);
  });

  it("GARDENER_COMMAND_RE matches all four commands", () => {
    expect(GARDENER_COMMAND_RE.test("@gardener re-review")).toBe(true);
    expect(GARDENER_COMMAND_RE.test("@gardener pause")).toBe(true);
    expect(GARDENER_COMMAND_RE.test("@gardener resume")).toBe(true);
    expect(GARDENER_COMMAND_RE.test("@gardener ignore")).toBe(true);
    expect(GARDENER_COMMAND_RE.test("@gardener unknown")).toBe(false);
  });

  it("state/ignored marker regexes work", () => {
    expect(
      GARDENER_STATE_MARKER_RE.test("<!-- gardener:state · reviewed=a -->"),
    ).toBe(true);
    expect(GARDENER_IGNORED_MARKER_RE.test("<!-- gardener:ignored -->")).toBe(
      true,
    );
  });

  // ─── #178: quiet_refresh_cid marker parser ───
  it("parseStateMarker returns quietRefreshCid when populated on separate line", () => {
    const body = [
      "<!-- gardener:state · reviewed=abc · verdict=ALIGNED · severity=low · tree_sha=def -->",
      "<!-- gardener:last_consumed_rereview=none -->",
      "<!-- gardener:quiet_refresh_cid=4271884496 -->",
      "body goes here",
    ].join("\n");
    const parsed = parseStateMarker(body);
    expect(parsed?.reviewed).toBe("abc");
    expect(parsed?.quietRefreshCid).toBe("4271884496");
  });

  it("parseStateMarker leaves quietRefreshCid undefined when marker line is absent (legacy comments)", () => {
    const body = [
      "<!-- gardener:state · reviewed=abc · verdict=ALIGNED · severity=low · tree_sha=def -->",
      "<!-- gardener:last_consumed_rereview=none -->",
      "body goes here",
    ].join("\n");
    const parsed = parseStateMarker(body);
    expect(parsed?.reviewed).toBe("abc");
    expect(parsed?.quietRefreshCid).toBeUndefined();
  });

  it("parseStateMarker treats the <self> placeholder as cid=undefined (comment was POSTed but not yet PATCHed)", () => {
    const body = [
      "<!-- gardener:state · reviewed=abc · verdict=ALIGNED · severity=low · tree_sha=def -->",
      "<!-- gardener:last_consumed_rereview=none -->",
      `<!-- gardener:quiet_refresh_cid=${QUIET_REFRESH_CID_PLACEHOLDER} -->`,
    ].join("\n");
    const parsed = parseStateMarker(body);
    expect(parsed?.quietRefreshCid).toBeUndefined();
  });

  it("parseStateMarker treats an empty-value cid line as undefined", () => {
    const body = [
      "<!-- gardener:state · reviewed=abc · verdict=ALIGNED · severity=low · tree_sha=def -->",
      "<!-- gardener:quiet_refresh_cid= -->",
    ].join("\n");
    const parsed = parseStateMarker(body);
    expect(parsed?.quietRefreshCid).toBeUndefined();
  });

  // ─── #178: withQuietRefreshCid writer ───
  it("withQuietRefreshCid replaces placeholder with real comment id", () => {
    const body = [
      "<!-- gardener:state · reviewed=abc -->",
      `<!-- gardener:quiet_refresh_cid=${QUIET_REFRESH_CID_PLACEHOLDER} -->`,
      "body",
    ].join("\n");
    const patched = withQuietRefreshCid(body, 9876);
    expect(patched).not.toBeNull();
    expect(patched).toContain("<!-- gardener:quiet_refresh_cid=9876 -->");
    expect(patched).not.toContain("<self>");
    expect(parseStateMarker(patched!)?.quietRefreshCid).toBe("9876");
  });

  it("withQuietRefreshCid is idempotent on an already-patched body (no-op diff)", () => {
    const body = [
      "<!-- gardener:state · reviewed=abc -->",
      "<!-- gardener:quiet_refresh_cid=9876 -->",
      "body",
    ].join("\n");
    const patched = withQuietRefreshCid(body, 9876);
    expect(patched).toBe(body);
  });

  it("withQuietRefreshCid returns null when body has no quiet_refresh_cid line (caller logs & skips)", () => {
    const body = "<!-- gardener:state · reviewed=abc -->\nbody";
    expect(withQuietRefreshCid(body, 9876)).toBeNull();
  });

  it("QUIET_REFRESH_CID_MARKER_RE captures the id from a real marker line", () => {
    const m = "<!-- gardener:quiet_refresh_cid=12345 -->".match(
      QUIET_REFRESH_CID_MARKER_RE,
    );
    expect(m?.[1]).toBe("12345");
  });
});

// ─────────────── 10. self-loop guard — first-tree:sync label ───────────────
describe("gardener comment -- self-loop guard (first-tree:sync label)", () => {
  it("exits 0 with skip message when PR carries first-tree:sync, without calling classify", async () => {
    const tmp = useTmpDir();
    const snapshotDir = join(tmp.path, "snap");
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(
      join(snapshotDir, "pr-view.json"),
      JSON.stringify({
        number: 301,
        title: "sync: tree content",
        headRefName: "first-tree/sync-301",
        headRefOid: "abcd1234",
        state: "OPEN",
        author: { login: "serenakeyitan" },
        additions: 10,
        deletions: 3,
        labels: [{ name: "first-tree:sync" }],
        updatedAt: "2026-04-16T00:00:00Z",
      }),
    );
    writeFileSync(join(snapshotDir, "issue-comments.json"), JSON.stringify([]));
    writeFileSync(
      join(snapshotDir, "subject.json"),
      JSON.stringify({ gardenerUser: "repo-gardener" }),
    );
    writeFileSync(join(snapshotDir, "pr.diff"), "");

    const calls: ShellCall[] = [];
    const shell = makeShell(
      [() => ({ stdout: "", stderr: "", code: 0 })],
      calls,
    );
    const { write, lines } = captureWrite();
    let classifyCalled = false;
    const code = await runComment(
      ["--pr", "301", "--repo", "owner/tree", "--tree-path", tmp.path],
      {
        shellRun: shell,
        write,
        env: { BREEZE_SNAPSHOT_DIR: snapshotDir },
        now: () => new Date("2026-04-16T00:00:00Z"),
        classifier: async () => {
          classifyCalled = true;
          return {
            verdict: "ALIGNED",
            severity: "low",
            summary: "should not run",
            treeNodes: [],
          };
        },
      },
    );
    expect(code).toBe(0);
    expect(classifyCalled).toBe(false);
    expect(
      lines.some((l) => l.includes("first-tree:sync label")),
    ).toBe(true);
    const last = lines[lines.length - 1];
    expect(last).toMatch(/^BREEZE_RESULT: status=skipped summary=sync PR/);
    // No gh pr comment / api post should have been issued.
    const writes = calls.filter(
      (c) =>
        c.command === "gh" &&
        (c.args[0] === "pr" && c.args[1] === "comment") ||
        (c.command === "gh" && c.args[0] === "api" && c.args.includes("POST")),
    );
    expect(writes).toHaveLength(0);
  });

  it("proceeds normally when PR carries other labels", async () => {
    const tmp = useTmpDir();
    const snapshotDir = join(tmp.path, "snap");
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(
      join(snapshotDir, "pr-view.json"),
      JSON.stringify({
        number: 302,
        title: "feat: new feature",
        headRefName: "feature/new",
        headRefOid: "efgh5678",
        state: "OPEN",
        author: { login: "external-contrib" },
        additions: 5,
        deletions: 1,
        labels: [{ name: "enhancement" }],
        updatedAt: "2026-04-16T00:00:00Z",
      }),
    );
    writeFileSync(join(snapshotDir, "issue-comments.json"), JSON.stringify([]));
    writeFileSync(
      join(snapshotDir, "subject.json"),
      JSON.stringify({ gardenerUser: "repo-gardener", treeSha: "tsha1234" }),
    );
    writeFileSync(join(snapshotDir, "pr.diff"), "");

    const calls: ShellCall[] = [];
    const shell = makeShell(
      [() => ({ stdout: "", stderr: "", code: 0 })],
      calls,
    );
    const { write, lines } = captureWrite();
    let classifyCalled = false;
    const code = await runComment(
      ["--pr", "302", "--repo", "owner/source", "--tree-path", tmp.path],
      {
        shellRun: shell,
        write,
        env: { BREEZE_SNAPSHOT_DIR: snapshotDir },
        now: () => new Date("2026-04-16T00:00:00Z"),
        classifier: async () => {
          classifyCalled = true;
          return {
            verdict: "ALIGNED",
            severity: "low",
            summary: "Looks aligned.",
            treeNodes: [],
          };
        },
      },
    );
    expect(code).toBe(0);
    expect(classifyCalled).toBe(true);
    expect(
      lines.some((l) => l.includes("first-tree:sync label")),
    ).toBe(false);
  });
});

describe("gardener comment -- @gardener command detection ignores self-footer", () => {
  it("does not treat @gardener re-review inside gardener's own state comment as a user command", () => {
    // Gardener's footer text includes `@gardener re-review` as a command
    // hint — resolveState must NOT treat this as a fresh user-issued
    // command. We verify by giving the only such comment a gardener
    // login AND a gardener: marker, and asserting state falls through
    // to the sha-match / reviewed-label path rather than rereview.
    const action = resolveState({
      comments: [
        {
          user: { login: "repo-gardener" },
          body:
            "<!-- gardener:state · reviewed=headSha -->\nverdict text\n<sub>Commands: <code>@gardener re-review</code></sub>",
          created_at: "2026-04-16T00:00:00Z",
        },
      ],
      gardenerUser: "repo-gardener",
      headIdentifier: "headSha",
      hasReviewedLabel: false,
    });
    expect(action.kind).toBe("skip");
  });

  it("does not treat @gardener re-review in a non-gardener-login comment that carries a gardener marker as user command", () => {
    // Marker-fallback path: a comment carries `<!-- gardener:` even
    // though login does not match gardenerUser (e.g. a bot identity
    // swap). We must still exclude it from userCommands.
    const action = resolveState({
      comments: [
        {
          user: { login: "old-bot-identity" },
          body:
            "<!-- gardener:state · reviewed=headSha -->\nverdict text <code>@gardener re-review</code>",
          created_at: "2026-04-16T00:00:00Z",
        },
      ],
      gardenerUser: "repo-gardener",
      headIdentifier: "headSha",
      hasReviewedLabel: false,
    });
    // Marker hides it from userCommands → sha matches → skip.
    expect(action.kind).toBe("skip");
  });
});

describe("commentLogPath (#159 — log-dir fallback)", () => {
  it("uses COMMENT_LOG verbatim when set", () => {
    const path = commentLogPath({ COMMENT_LOG: "/custom/path/log.jsonl" });
    expect(path).toBe("/custom/path/log.jsonl");
  });

  it("uses HOME when set", () => {
    const path = commentLogPath({ HOME: "/home/user" });
    expect(path).toBe("/home/user/.gardener/comment-runs.jsonl");
  });

  it("falls back to USERPROFILE on Windows-style env", () => {
    const path = commentLogPath({ USERPROFILE: "C:\\Users\\user" });
    expect(path.startsWith("C:\\Users\\user")).toBe(true);
    expect(path.endsWith("comment-runs.jsonl")).toBe(true);
  });

  it("falls back to os.tmpdir() when HOME and USERPROFILE are unset (regression for #159)", async () => {
    const { tmpdir } = await import("node:os");
    const path = commentLogPath({});
    expect(path.startsWith(tmpdir())).toBe(true);
    expect(path.endsWith("comment-runs.jsonl")).toBe(true);
  });

  it("never returns a path inside process.cwd() when HOME is unset (regression for #159)", () => {
    const path = commentLogPath({});
    expect(path.startsWith(process.cwd())).toBe(false);
    expect(path.endsWith("comment-runs.jsonl")).toBe(true);
  });
});

describe("gardener comment -- Phase 2a tree-issue primitives", () => {
  // ─────────────────── withTreeIssueCreatedField ───────────────────
  it("withTreeIssueCreatedField appends field to marker that lacks it", () => {
    const body =
      "<!-- gardener:state · reviewed=abc · verdict=NEW_TERRITORY · severity=medium · tree_sha=def -->\nhello";
    const out = withTreeIssueCreatedField(
      body,
      "https://github.com/alice/tree/issues/7",
    );
    expect(out).toContain(
      "tree_issue_created=https://github.com/alice/tree/issues/7",
    );
    // Existing fields preserved:
    expect(out).toContain("reviewed=abc");
    expect(out).toContain("verdict=NEW_TERRITORY");
    expect(out).toContain("tree_sha=def");
    expect(out).toContain("\nhello");
    // Round-trips through parser:
    expect(parseStateMarker(out!)?.treeIssueCreated).toBe(
      "https://github.com/alice/tree/issues/7",
    );
  });

  it("withTreeIssueCreatedField replaces field when present (idempotent on retry)", () => {
    const body =
      "<!-- gardener:state · reviewed=abc · tree_issue_created=https://github.com/alice/tree/issues/1 -->";
    const out = withTreeIssueCreatedField(
      body,
      "https://github.com/alice/tree/issues/2",
    );
    expect(out).toContain("tree_issue_created=https://github.com/alice/tree/issues/2");
    expect(out).not.toContain("tree_issue_created=https://github.com/alice/tree/issues/1");
  });

  it("withTreeIssueCreatedField returns null for body with no gardener marker", () => {
    expect(
      withTreeIssueCreatedField(
        "random body no marker",
        "https://github.com/a/b/issues/1",
      ),
    ).toBeNull();
  });

  it("withTreeIssueCreatedField is idempotent — applying twice yields same result", () => {
    const body =
      "<!-- gardener:state · reviewed=abc · verdict=ALIGNED · severity=low · tree_sha=d -->";
    const url = "https://github.com/alice/tree/issues/9";
    const once = withTreeIssueCreatedField(body, url)!;
    const twice = withTreeIssueCreatedField(once, url)!;
    expect(twice).toBe(once);
  });

  // ─────────────────── codeownersForPath ───────────────────
  it("codeownersForPath returns owners for longest last-match directory rule", () => {
    const co = [
      "* @default",
      "/pkg-a/ @alice",
      "/pkg-a/sub/ @bob",
    ].join("\n");
    expect(codeownersForPath(co, "pkg-a/sub/foo.ts")).toEqual(["@bob"]);
    expect(codeownersForPath(co, "pkg-a/foo.ts")).toEqual(["@alice"]);
    expect(codeownersForPath(co, "pkg-b/foo.ts")).toEqual(["@default"]);
  });

  it("codeownersForPath returns empty when no rules match and no fallback", () => {
    const co = "/pkg-a/ @alice\n";
    expect(codeownersForPath(co, "pkg-b/foo.ts")).toEqual([]);
  });

  it("codeownersForPath supports multi-owner lines and strips extra @ prefixes", () => {
    const co = "/pkg-a/ @alice @@bob @team/frontend\n";
    expect(codeownersForPath(co, "pkg-a/foo.ts")).toEqual([
      "@alice",
      "@bob",
      "@team/frontend",
    ]);
  });

  it("codeownersForPath ignores comment and blank lines", () => {
    const co = [
      "# header",
      "",
      "/pkg-a/ @alice # inline comment",
      "",
    ].join("\n");
    expect(codeownersForPath(co, "pkg-a/foo.ts")).toEqual(["@alice"]);
  });

  it("codeownersForPath handles exact file patterns", () => {
    const co = "/README.md @docs\n/pkg-a/ @alice\n";
    expect(codeownersForPath(co, "README.md")).toEqual(["@docs"]);
    expect(codeownersForPath(co, "pkg-a/README.md")).toEqual(["@alice"]);
  });

  // ─────────────────── buildTreeIssueBody ───────────────────
  it("buildTreeIssueBody composes a tree-repo-audience issue body", () => {
    const body = buildTreeIssueBody({
      sourceRepo: "alice/cool",
      sourcePr: 101,
      sourcePrTitle: "feat(pkg-a): add thing",
      sourceCommentUrl: "https://github.com/alice/cool/pull/101#issuecomment-999",
      verdict: "NEW_TERRITORY",
      severity: "medium",
      summary: "Introduces new module pkg-a that isn't covered by any tree node.",
      treeNodes: [{ path: "pkg-a", summary: "(none cited)" }],
      codeownersMentions: ["@alice", "@team/frontend"],
    });
    expect(body).toContain("Merged source change needs tree review");
    expect(body).toContain("[alice/cool#101](https://github.com/alice/cool/pull/101)");
    expect(body).toContain("feat(pkg-a): add thing");
    expect(body).toContain("#issuecomment-999");
    expect(body).toContain("`NEW_TERRITORY`");
    expect(body).toContain("`medium`");
    expect(body).toContain("Introduces new module pkg-a");
    expect(body).toContain("`pkg-a`");
    expect(body).toContain("cc @alice @team/frontend");
    expect(body).toContain("Auto-filed by [repo-gardener]");
  });

  it("buildTreeIssueBody handles empty CODEOWNERS mentions gracefully", () => {
    const body = buildTreeIssueBody({
      sourceRepo: "alice/cool",
      sourcePr: 102,
      sourcePrTitle: "chore: tweak",
      sourceCommentUrl: "https://github.com/alice/cool/pull/102#issuecomment-1",
      verdict: "ALIGNED",
      severity: "low",
      summary: "Minor tweak.",
      treeNodes: [],
      codeownersMentions: [],
    });
    expect(body).toContain("no CODEOWNERS match");
    expect(body).not.toContain("cc @");
    expect(body).toContain("(no tree nodes cited)");
  });

  // ─────────────────── --assign-owners path ───────────────────

  it("buildTreeIssueBody with autoAssigned=true swaps the action line", () => {
    const body = buildTreeIssueBody({
      sourceRepo: "alice/cool",
      sourcePr: 103,
      sourcePrTitle: "feat: thing",
      sourceCommentUrl: "https://github.com/alice/cool/pull/103#issuecomment-2",
      verdict: "NEW_TERRITORY",
      severity: "medium",
      summary: "New surface area.",
      treeNodes: [{ path: "pkg-a", summary: "" }],
      codeownersMentions: ["@alice", "@bob"],
      autoAssigned: true,
    });
    expect(body).toContain("auto-assigned to the node owners cited above");
    expect(body).not.toContain("not auto-assigned");
    expect(body).toContain("cc @alice @bob");
  });

  it("buildTreeIssueBody with autoAssigned=true but no mentions keeps pull-mode language", () => {
    const body = buildTreeIssueBody({
      sourceRepo: "alice/cool",
      sourcePr: 104,
      sourcePrTitle: "chore",
      sourceCommentUrl: "https://github.com/alice/cool/pull/104#issuecomment-3",
      verdict: "ALIGNED",
      severity: "low",
      summary: "No-op.",
      treeNodes: [],
      codeownersMentions: [],
      autoAssigned: true,
    });
    // No assignees to honor — fall back to pull-mode phrasing so the
    // body doesn't lie about what GitHub did.
    expect(body).toContain("not auto-assigned");
  });

  describe("assigneesFromMentions", () => {
    it("strips leading @ and dedupes while preserving order", () => {
      expect(
        assigneesFromMentions(["@alice", "@bob", "@alice", "@carol"]),
      ).toEqual(["alice", "bob", "carol"]);
    });

    it("drops team mentions (GitHub rejects them for issue assignees)", () => {
      expect(
        assigneesFromMentions(["@alice", "@team/frontend", "@bob"]),
      ).toEqual(["alice", "bob"]);
    });

    it("caps output at 10 entries", () => {
      const mentions = Array.from({ length: 15 }, (_, i) => `@u${i}`);
      expect(assigneesFromMentions(mentions)).toHaveLength(10);
    });

    it("ignores blank entries", () => {
      expect(assigneesFromMentions(["@", "", "@alice"])).toEqual(["alice"]);
    });
  });
});

// ─────────────────── Phase 2b: MERGED → tree-repo issue ───────────────────

describe("gardener comment -- MERGED-PR scan branch (#193, Phase 2b of #162)", () => {
  // Shared fixture: a merged source PR with an existing gardener:state
  // marker comment that has no `tree_issue_created` field yet.
  function writeMergedSnapshot(
    snapshotDir: string,
    opts: { markerExtras?: string } = {},
  ): void {
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(
      join(snapshotDir, "pr-view.json"),
      JSON.stringify({
        number: 42,
        title: "feat: add thing",
        headRefOid: "dead1234",
        state: "MERGED",
        author: { login: "someone" },
        additions: 10,
        deletions: 0,
        updatedAt: "2026-04-16T00:00:00Z",
      }),
    );
    const markerSuffix = opts.markerExtras ? ` · ${opts.markerExtras}` : "";
    writeFileSync(
      join(snapshotDir, "issue-comments.json"),
      JSON.stringify([
        {
          id: 9001,
          user: { login: "repo-gardener" },
          created_at: "2026-04-15T00:00:00Z",
          body:
            `<!-- gardener:state · reviewed=dead1234 · verdict=NEW_TERRITORY ` +
            `· severity=medium · tree_sha=tsha1234${markerSuffix} -->\n\n` +
            `🌱 **gardener** · NEW_TERRITORY\n`,
        },
      ]),
    );
    writeFileSync(
      join(snapshotDir, "subject.json"),
      JSON.stringify({ gardenerUser: "repo-gardener", treeSha: "tsha1234" }),
    );
    writeFileSync(join(snapshotDir, "pr.diff"), "");
  }

  const mergedClassifier: Classifier = async () => ({
    verdict: "NEW_TERRITORY",
    severity: "medium",
    summary: "Introduces a new area not covered by the tree.",
    treeNodes: [{ path: "product/NODE.md", summary: "product scope" }],
  });

  it("TREE_REPO_TOKEN unset → skipped with tree_repo_token=absent trailer", async () => {
    const tmp = useTmpDir();
    const snapshotDir = join(tmp.path, "snap");
    writeMergedSnapshot(snapshotDir);
    writeConfig(tmp.path, "tree_repo: o/tree\ntarget_repo: o/src\n");

    const calls: ShellCall[] = [];
    const shell = makeShell(
      [() => ({ stdout: "", stderr: "", code: 0 })],
      calls,
    );
    const { write, lines } = captureWrite();

    const code = await runComment(
      ["--pr", "42", "--repo", "o/src", "--tree-path", tmp.path],
      {
        shellRun: shell,
        write,
        env: { BREEZE_SNAPSHOT_DIR: snapshotDir },
        classifier: mergedClassifier,
      },
    );

    expect(code).toBe(0);
    const trailer = lines[lines.length - 1];
    expect(trailer).toMatch(/^BREEZE_RESULT: status=skipped /);
    expect(trailer).toContain("tree_repo_token=absent");
    expect(trailer).toContain("TREE_REPO_TOKEN");
    expect(calls.some((c) => c.args.includes("create"))).toBe(false);
  });

  it("marker already has tree_issue_created → skipped, no issue-create call", async () => {
    const tmp = useTmpDir();
    const snapshotDir = join(tmp.path, "snap");
    writeMergedSnapshot(snapshotDir, {
      markerExtras: "tree_issue_created=https://github.com/o/tree/issues/7",
    });
    writeConfig(tmp.path, "tree_repo: o/tree\ntarget_repo: o/src\n");

    const calls: ShellCall[] = [];
    const shell = makeShell(
      [() => ({ stdout: "", stderr: "", code: 0 })],
      calls,
    );
    const { write, lines } = captureWrite();

    const code = await runComment(
      ["--pr", "42", "--repo", "o/src", "--tree-path", tmp.path],
      {
        shellRun: shell,
        write,
        env: {
          BREEZE_SNAPSHOT_DIR: snapshotDir,
          TREE_REPO_TOKEN: "tok-xyz",
        },
        classifier: mergedClassifier,
      },
    );

    expect(code).toBe(0);
    expect(lines[lines.length - 1]).toContain("already linked");
    expect(calls.some((c) => c.args[0] === "issue")).toBe(false);
    expect(calls.some((c) => c.args[1] === "PATCH")).toBe(false);
  });

  it("happy path: creates tree issue and PATCHes the source-PR marker", async () => {
    const tmp = useTmpDir();
    const snapshotDir = join(tmp.path, "snap");
    writeMergedSnapshot(snapshotDir);
    writeConfig(tmp.path, "tree_repo: o/tree\ntarget_repo: o/src\n");

    const calls: ShellCall[] = [];
    const shell = makeShell(
      [
        (call) => {
          if (call.args[0] === "issue" && call.args[1] === "create") {
            return {
              stdout: "https://github.com/o/tree/issues/123\n",
              stderr: "",
              code: 0,
            };
          }
          return null;
        },
        () => ({ stdout: "", stderr: "", code: 0 }),
      ],
      calls,
    );
    const { write, lines } = captureWrite();

    const code = await runComment(
      ["--pr", "42", "--repo", "o/src", "--tree-path", tmp.path],
      {
        shellRun: shell,
        write,
        env: {
          BREEZE_SNAPSHOT_DIR: snapshotDir,
          TREE_REPO_TOKEN: "tok-xyz",
        },
        classifier: mergedClassifier,
      },
    );

    expect(code).toBe(0);

    const issueCreate = calls.find(
      (c) => c.args[0] === "issue" && c.args[1] === "create",
    );
    expect(issueCreate).toBeDefined();
    expect(issueCreate!.args).toContain("--repo");
    expect(issueCreate!.args).toContain("o/tree");
    expect(issueCreate!.args).toContain("--title");
    const titleIdx = issueCreate!.args.indexOf("--title");
    expect(issueCreate!.args[titleIdx + 1]).toBe(
      "[gardener] tree update needed for o/src#42",
    );

    const patch = calls.find(
      (c) => c.args[0] === "api" && c.args[1] === "-X" && c.args[2] === "PATCH",
    );
    expect(patch).toBeDefined();
    expect(patch!.args[3]).toBe("/repos/o/src/issues/comments/9001");
    const bodyArg = patch!.args[5];
    expect(bodyArg).toContain("body=");
    expect(bodyArg).toContain(
      "tree_issue_created=https://github.com/o/tree/issues/123",
    );

    const trailer = lines[lines.length - 1];
    expect(trailer).toMatch(/^BREEZE_RESULT: status=handled /);
    expect(trailer).toContain("tree_repo_token=present");
    expect(trailer).toContain("https://github.com/o/tree/issues/123");
  });

  it("issue-create 404 → skipped (config error), no PATCH", async () => {
    const tmp = useTmpDir();
    const snapshotDir = join(tmp.path, "snap");
    writeMergedSnapshot(snapshotDir);
    writeConfig(tmp.path, "tree_repo: o/tree\ntarget_repo: o/src\n");

    const calls: ShellCall[] = [];
    const shell = makeShell(
      [
        (call) => {
          if (call.args[0] === "issue" && call.args[1] === "create") {
            return {
              stdout: "",
              stderr: "HTTP 404: Not Found (o/tree)",
              code: 1,
            };
          }
          return null;
        },
        () => ({ stdout: "", stderr: "", code: 0 }),
      ],
      calls,
    );
    const { write, lines } = captureWrite();

    const code = await runComment(
      ["--pr", "42", "--repo", "o/src", "--tree-path", tmp.path],
      {
        shellRun: shell,
        write,
        env: {
          BREEZE_SNAPSHOT_DIR: snapshotDir,
          TREE_REPO_TOKEN: "tok-xyz",
        },
        classifier: mergedClassifier,
      },
    );

    expect(code).toBe(0);
    expect(lines[lines.length - 1]).toMatch(/^BREEZE_RESULT: status=skipped /);
    expect(lines[lines.length - 1]).toContain("tree_repo_token=present");
    expect(calls.some((c) => c.args[1] === "PATCH")).toBe(false);
  });

  it("issue-create 503 → failed with issue URL absent", async () => {
    const tmp = useTmpDir();
    const snapshotDir = join(tmp.path, "snap");
    writeMergedSnapshot(snapshotDir);
    writeConfig(tmp.path, "tree_repo: o/tree\ntarget_repo: o/src\n");

    const calls: ShellCall[] = [];
    const shell = makeShell(
      [
        (call) => {
          if (call.args[0] === "issue" && call.args[1] === "create") {
            return {
              stdout: "",
              stderr: "HTTP 503: Service Unavailable",
              code: 1,
            };
          }
          return null;
        },
        () => ({ stdout: "", stderr: "", code: 0 }),
      ],
      calls,
    );
    const { write, lines } = captureWrite();

    const code = await runComment(
      ["--pr", "42", "--repo", "o/src", "--tree-path", tmp.path],
      {
        shellRun: shell,
        write,
        env: {
          BREEZE_SNAPSHOT_DIR: snapshotDir,
          TREE_REPO_TOKEN: "tok-xyz",
        },
        classifier: mergedClassifier,
      },
    );

    expect(code).toBe(1);
    expect(lines[lines.length - 1]).toMatch(/^BREEZE_RESULT: status=failed /);
    expect(calls.some((c) => c.args[1] === "PATCH")).toBe(false);
  });

  it("create succeeds, PATCH fails → failed but logs issue URL for manual recovery", async () => {
    const tmp = useTmpDir();
    const snapshotDir = join(tmp.path, "snap");
    writeMergedSnapshot(snapshotDir);
    writeConfig(tmp.path, "tree_repo: o/tree\ntarget_repo: o/src\n");

    const calls: ShellCall[] = [];
    const shell = makeShell(
      [
        (call) => {
          if (call.args[0] === "issue" && call.args[1] === "create") {
            return {
              stdout: "https://github.com/o/tree/issues/124\n",
              stderr: "",
              code: 0,
            };
          }
          if (call.args[0] === "api" && call.args[1] === "-X" && call.args[2] === "PATCH") {
            return { stdout: "", stderr: "HTTP 500", code: 1 };
          }
          return null;
        },
        () => ({ stdout: "", stderr: "", code: 0 }),
      ],
      calls,
    );
    const { write, lines } = captureWrite();

    const code = await runComment(
      ["--pr", "42", "--repo", "o/src", "--tree-path", tmp.path],
      {
        shellRun: shell,
        write,
        env: {
          BREEZE_SNAPSHOT_DIR: snapshotDir,
          TREE_REPO_TOKEN: "tok-xyz",
        },
        classifier: mergedClassifier,
      },
    );

    expect(code).toBe(1);
    expect(lines[lines.length - 1]).toMatch(/^BREEZE_RESULT: status=failed /);
    // Issue URL must appear in log output so operators can recover.
    expect(lines.some((l) => l.includes("https://github.com/o/tree/issues/124")))
      .toBe(true);
  });

  it("MERGED PR without a gardener marker → falls through to existing stale skip", async () => {
    const tmp = useTmpDir();
    const snapshotDir = join(tmp.path, "snap");
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(
      join(snapshotDir, "pr-view.json"),
      JSON.stringify({
        number: 42,
        title: "random merged PR",
        headRefOid: "beef0000",
        state: "MERGED",
        author: { login: "someone" },
        additions: 1,
        deletions: 0,
        updatedAt: "2026-04-16T00:00:00Z",
      }),
    );
    writeFileSync(join(snapshotDir, "issue-comments.json"), JSON.stringify([]));
    writeFileSync(
      join(snapshotDir, "subject.json"),
      JSON.stringify({ gardenerUser: "repo-gardener" }),
    );
    writeFileSync(join(snapshotDir, "pr.diff"), "");
    writeConfig(tmp.path, "tree_repo: o/tree\ntarget_repo: o/src\n");

    const calls: ShellCall[] = [];
    const shell = makeShell(
      [() => ({ stdout: "", stderr: "", code: 0 })],
      calls,
    );
    const { write, lines } = captureWrite();

    const code = await runComment(
      ["--pr", "42", "--repo", "o/src", "--tree-path", tmp.path],
      {
        shellRun: shell,
        write,
        env: {
          BREEZE_SNAPSHOT_DIR: snapshotDir,
          TREE_REPO_TOKEN: "tok-xyz",
        },
        classifier: mergedClassifier,
      },
    );

    expect(code).toBe(0);
    expect(lines[lines.length - 1]).toMatch(/^BREEZE_RESULT: status=skipped /);
    expect(lines.some((l) => l.includes("MERGED since scan"))).toBe(true);
    expect(calls.some((c) => c.args[0] === "issue" && c.args[1] === "create"))
      .toBe(false);
  });
});

describe("gardener comment -- collectTargetRepos", () => {
  it("returns empty list when no config exists", () => {
    const tmp = useTmpDir();
    expect(collectTargetRepos(tmp.path, null)).toEqual([]);
  });

  it("reads scalar target_repo from YAML", () => {
    const tmp = useTmpDir();
    writeConfig(tmp.path, "tree_repo: o/tree\ntarget_repo: o/src\n");
    expect(collectTargetRepos(tmp.path, null)).toEqual(["o/src"]);
  });

  it("reads target_repos list from YAML (block form)", () => {
    const tmp = useTmpDir();
    writeConfig(
      tmp.path,
      "tree_repo: o/tree\ntarget_repos:\n  - o/a\n  - o/b\n",
    );
    expect(collectTargetRepos(tmp.path, null)).toEqual(["o/a", "o/b"]);
  });

  it("reads target_repos list from YAML (inline form)", () => {
    const tmp = useTmpDir();
    writeConfig(
      tmp.path,
      "tree_repo: o/tree\ntarget_repos: [o/a, 'o/b']\n",
    );
    expect(collectTargetRepos(tmp.path, null)).toEqual(["o/a", "o/b"]);
  });

  it("merges scalar + list + typed-config sources, deduped, in order", () => {
    const tmp = useTmpDir();
    writeConfig(
      tmp.path,
      "tree_repo: o/tree\ntarget_repo: o/scalar\ntarget_repos:\n  - o/list1\n  - o/scalar\n",
    );
    expect(
      collectTargetRepos(tmp.path, { target_repos: ["o/typed", "o/list1"] }),
    ).toEqual(["o/scalar", "o/list1", "o/typed"]);
  });
});

describe("gardener comment -- resolveMergedSinceISO", () => {
  const now = new Date("2026-04-21T00:00:00Z");

  it("parses hours", () => {
    expect(resolveMergedSinceISO("24h", now)).toBe("2026-04-20T00:00:00.000Z");
    expect(resolveMergedSinceISO("1h", now)).toBe("2026-04-20T23:00:00.000Z");
  });

  it("parses days and weeks", () => {
    expect(resolveMergedSinceISO("7d", now)).toBe("2026-04-14T00:00:00.000Z");
    expect(resolveMergedSinceISO("1w", now)).toBe("2026-04-14T00:00:00.000Z");
  });

  it("parses minutes", () => {
    expect(resolveMergedSinceISO("30m", now)).toBe("2026-04-20T23:30:00.000Z");
  });

  it("passes through ISO-8601", () => {
    expect(resolveMergedSinceISO("2026-04-15T10:00:00Z", now)).toBe(
      "2026-04-15T10:00:00.000Z",
    );
  });

  it("returns null on junk", () => {
    expect(resolveMergedSinceISO("yesterday", now)).toBeNull();
    expect(resolveMergedSinceISO("", now)).toBeNull();
    expect(resolveMergedSinceISO("0h", now)).toBeNull();
    expect(resolveMergedSinceISO("-1h", now)).toBeNull();
  });
});

describe("gardener comment -- multi target_repos scan", () => {
  it("iterates each target_repo and aggregates BREEZE_RESULT", async () => {
    const tmp = useTmpDir();
    writeConfig(
      tmp.path,
      "tree_repo: o/tree\ntarget_repos:\n  - o/a\n  - o/b\n",
    );

    const calls: ShellCall[] = [];
    const shell = makeShell(
      [
        // Both repos return empty pr/issue lists.
        () => ({ stdout: "[]", stderr: "", code: 0 }),
      ],
      calls,
    );
    const { write, lines } = captureWrite();

    const code = await runComment(["--tree-path", tmp.path], {
      shellRun: shell,
      write,
      classifier: alignedClassifier,
    });

    expect(code).toBe(0);
    const prListCalls = calls.filter(
      (c) => c.command === "gh" && c.args[0] === "pr" && c.args[1] === "list",
    );
    // One open-pr list per target_repo (no merged sweep without flag).
    expect(prListCalls).toHaveLength(2);
    expect(prListCalls[0].args).toContain("o/a");
    expect(prListCalls[1].args).toContain("o/b");
    const trailer = lines[lines.length - 1];
    expect(trailer).toMatch(/^BREEZE_RESULT: status=skipped /);
    expect(trailer).toContain("repos=2");
  });

  it("--merged-since adds a merged PR list per repo with search filter", async () => {
    const tmp = useTmpDir();
    writeConfig(
      tmp.path,
      "tree_repo: o/tree\ntarget_repos:\n  - o/a\n  - o/b\n",
    );

    const calls: ShellCall[] = [];
    const shell = makeShell(
      [() => ({ stdout: "[]", stderr: "", code: 0 })],
      calls,
    );
    const { write } = captureWrite();
    const fixedNow = new Date("2026-04-21T00:00:00Z");

    const code = await runComment(
      ["--tree-path", tmp.path, "--merged-since", "24h"],
      {
        shellRun: shell,
        write,
        now: () => fixedNow,
        classifier: alignedClassifier,
      },
    );

    expect(code).toBe(0);
    const mergedListCalls = calls.filter(
      (c) =>
        c.command === "gh" &&
        c.args[0] === "pr" &&
        c.args[1] === "list" &&
        c.args.includes("merged"),
    );
    // One merged-state pr list per target_repo.
    expect(mergedListCalls).toHaveLength(2);
    for (const call of mergedListCalls) {
      const searchIdx = call.args.indexOf("--search");
      expect(searchIdx).toBeGreaterThan(-1);
      expect(call.args[searchIdx + 1]).toBe(
        "merged:>=2026-04-20T00:00:00.000Z",
      );
    }
  });

  it("rejects unparseable --merged-since with failed BREEZE_RESULT", async () => {
    const tmp = useTmpDir();
    writeConfig(tmp.path, "tree_repo: o/tree\ntarget_repo: o/a\n");

    const shell = makeShell([() => ({ stdout: "[]", stderr: "", code: 0 })]);
    const { write, lines } = captureWrite();

    const code = await runComment(
      ["--tree-path", tmp.path, "--merged-since", "yesterday"],
      { shellRun: shell, write, classifier: alignedClassifier },
    );

    expect(code).toBe(1);
    expect(lines[lines.length - 1]).toMatch(/^BREEZE_RESULT: status=failed /);
  });

  it("fails cleanly when neither target_repo nor target_repos is set", async () => {
    const tmp = useTmpDir();
    writeConfig(tmp.path, "tree_repo: o/tree\n");

    const shell = makeShell([() => ({ stdout: "", stderr: "", code: 0 })]);
    const { write, lines } = captureWrite();

    const code = await runComment(["--tree-path", tmp.path], {
      shellRun: shell,
      write,
      classifier: alignedClassifier,
    });

    expect(code).toBe(1);
    expect(lines[lines.length - 1]).toMatch(/^BREEZE_RESULT: status=failed /);
    expect(lines.some((l) => l.includes("no target_repo or target_repos")))
      .toBe(true);
  });
});
