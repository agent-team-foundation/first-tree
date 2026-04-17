/**
 * sync.ts golden snapshot — locks the external-effects shape of
 * `first-tree sync --apply` so the Phase 3 refactor (factor out an
 * `openTreePr` primitive for the gardener merge→issue worker path)
 * cannot silently change what repo-gardener depends on.
 *
 * Repo-gardener (`agent-team-foundation/repo-gardener`) shells out to
 * `first-tree sync --apply` on a schedule. If the CLI changes commit
 * messages, PR titles, PR bodies, labels, branch names, or the order
 * of git/gh calls, repo-gardener's scheduled runs would produce
 * different PRs — a silent production break.
 *
 * This test captures EVERY git/gh call (args + key output hashes) made
 * by sync.ts during a scripted "two merged source PRs → two tree PRs"
 * flow, and asserts the capture matches a committed fixture
 * (`tests/fixtures/sync-golden/two-pr-apply.json`).
 *
 * Updating the snapshot: run with `UPDATE_SYNC_GOLDEN=1` env var — this
 * rewrites the fixture. Only do this when the change is *intentional*
 * and coordinated with a repo-gardener-side update.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runSync,
  type ShellResult,
  type ShellRun,
} from "#products/tree/engine/sync.js";
import { writeTreeBinding } from "#products/tree/engine/runtime/binding-state.js";
import { makeTreeMetadata, useTmpDir } from "../helpers.js";

const FIXTURE_PATH = join(
  __dirname,
  "..",
  "fixtures",
  "sync-golden",
  "two-pr-apply.json",
);

interface Captured {
  command: string;
  args: string[];
  cwdLabel: string | null;
}

interface Snapshot {
  exitCode: number;
  calls: Captured[];
  bodyHashes: Record<string, string>;
  nodeMdFiles: Record<string, string>;
}

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function makeTreeShell(root: string): void {
  makeTreeMetadata(root);
  writeFileSync(
    join(root, "NODE.md"),
    "---\ntitle: Example Tree\nowners: [alice]\n---\n# Example Tree\n",
  );
  writeFileSync(
    join(root, "AGENTS.md"),
    "<!-- BEGIN CONTEXT-TREE FRAMEWORK -->\nx\n<!-- END CONTEXT-TREE FRAMEWORK -->\n",
  );
  writeFileSync(
    join(root, "CLAUDE.md"),
    "<!-- BEGIN CONTEXT-TREE FRAMEWORK -->\nx\n<!-- END CONTEXT-TREE FRAMEWORK -->\n",
  );
  mkdirSync(join(root, ".github"), { recursive: true });
  writeFileSync(
    join(root, ".github", "CODEOWNERS"),
    "/pkg-a/ @alice\n/pkg-b/ @bob\n",
  );
}

function makeRecordingShell(
  tmpPath: string,
  classifyResponses: string[],
): { shellRun: ShellRun; captured: Captured[]; bodies: string[] } {
  const captured: Captured[] = [];
  const bodies: string[] = [];
  let classifyIndex = 0;

  const shellRun: ShellRun = async (command, args, options) => {
    const cwdLabel =
      options?.cwd === tmpPath
        ? "<tree-root>"
        : options?.cwd
          ? "<other>"
          : null;
    captured.push({ command, args: [...args], cwdLabel });

    if (command === "gh" && args[0] === "auth") {
      return { stdout: "Logged in", stderr: "", code: 0 };
    }
    if (command === "claude" && args[0] === "--version") {
      return { stdout: "1.0.0", stderr: "", code: 0 };
    }
    if (command === "gh" && args[0] === "api") {
      const path = args[1] ?? "";
      if (path === "/repos/alice/source/commits/HEAD") {
        return { stdout: "bb".repeat(20) + "\n", stderr: "", code: 0 };
      }
      if (path.startsWith("/repos/alice/source/compare/")) {
        return {
          stdout: JSON.stringify({
            commits: [
              {
                sha: "1".repeat(40),
                commit: {
                  message: "feat(pkg-a): add thing (#101)",
                  author: { name: "a", date: "2026-04-01T00:00:00Z" },
                },
                files: [{ filename: "pkg-a/x.ts" }],
              },
              {
                sha: "2".repeat(40),
                commit: {
                  message: "feat(pkg-b): add thing (#102)",
                  author: { name: "b", date: "2026-04-02T00:00:00Z" },
                },
                files: [{ filename: "pkg-b/y.ts" }],
              },
            ],
          }),
          stderr: "",
          code: 0,
        };
      }
      if (path.startsWith("search/issues")) {
        return {
          stdout: JSON.stringify({
            items: [
              {
                number: 101,
                title: "feat(pkg-a): add thing",
                pull_request: {
                  merged_at: "2026-04-01T00:00:00Z",
                  merge_commit_sha: "1".repeat(40),
                },
              },
              {
                number: 102,
                title: "feat(pkg-b): add thing",
                pull_request: {
                  merged_at: "2026-04-02T00:00:00Z",
                  merge_commit_sha: "2".repeat(40),
                },
              },
            ],
          }),
          stderr: "",
          code: 0,
        };
      }
    }
    if (command === "claude" && args[0] === "-p") {
      const response = classifyResponses[classifyIndex] ?? classifyResponses[0];
      classifyIndex += 1;
      return { stdout: response, stderr: "", code: 0 };
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "list") {
      return { stdout: "[]", stderr: "", code: 0 };
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "create") {
      const bodyIdx = args.indexOf("--body");
      if (bodyIdx >= 0 && args[bodyIdx + 1]) bodies.push(args[bodyIdx + 1]);
      const headIdx = args.indexOf("--head");
      const branch = headIdx >= 0 ? args[headIdx + 1] : "unknown";
      return {
        stdout: `https://github.com/alice/tree/pull/${branch.includes("pr101") ? 501 : 502}`,
        stderr: "",
        code: 0,
      };
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "edit") {
      return { stdout: "", stderr: "", code: 0 };
    }
    if (command === "gh" && args[0] === "label") {
      return { stdout: "", stderr: "", code: 0 };
    }
    if (command === "git") {
      if (args[0] === "symbolic-ref") {
        return { stdout: "main\n", stderr: "", code: 0 };
      }
      if (
        args.includes("diff")
        && args.includes("--cached")
        && args.includes("--quiet")
      ) {
        return { stdout: "", stderr: "", code: 1 };
      }
      return { stdout: "", stderr: "", code: 0 };
    }
    return {
      stdout: "",
      stderr: `no mock for ${command} ${args.join(" ")}`,
      code: 1,
    };
  };

  return { shellRun, captured, bodies };
}

function redact(calls: Captured[], treeRoot: string): Captured[] {
  return calls.map((c) => {
    const redactedArgs = c.args.map((a, i) => {
      const prev = c.args[i - 1];
      if (prev === "--body") return `<BODY_HASH:${hash(a)}>`;
      if (prev === "-m") return `<COMMIT_MSG_HASH:${hash(a)}>`;
      if (typeof a === "string" && a.startsWith(treeRoot)) {
        return `<TREE_ROOT>${a.slice(treeRoot.length)}`;
      }
      return a;
    });
    return { command: c.command, args: redactedArgs, cwdLabel: c.cwdLabel };
  });
}

function extractBodies(calls: Captured[]): Record<string, string> {
  const out: Record<string, string> = {};
  let commitIdx = 0;
  let prIdx = 0;
  for (const c of calls) {
    if (c.command === "gh" && c.args[0] === "pr" && c.args[1] === "create") {
      const bodyIdx = c.args.indexOf("--body");
      const titleIdx = c.args.indexOf("--title");
      const headIdx = c.args.indexOf("--head");
      const label =
        headIdx >= 0
          ? c.args[headIdx + 1]
          : titleIdx >= 0
            ? `title:${c.args[titleIdx + 1]}`
            : `pr-${prIdx}`;
      prIdx += 1;
      if (bodyIdx >= 0) out[`pr-body::${label}`] = c.args[bodyIdx + 1];
    }
    if (c.command === "git" && c.args[0] === "commit") {
      const mIdx = c.args.indexOf("-m");
      if (mIdx >= 0) {
        out[`commit-msg::${commitIdx}`] = c.args[mIdx + 1];
        commitIdx += 1;
      }
    }
  }
  return out;
}

describe("sync --apply golden snapshot (Phase 0.a)", () => {
  it("produces byte-identical git/gh call shape for two-PR scheduled sync", async () => {
    const tmp = useTmpDir();
    makeTreeShell(tmp.path);
    writeTreeBinding(tmp.path, "source-golden", {
      bindingMode: "standalone-source",
      entrypoint: "/repos/source",
      lastReconciledSourceCommit: "aa".repeat(20),
      remoteUrl: "https://github.com/alice/source.git",
      rootKind: "git-repo",
      scope: "repo",
      sourceId: "source-golden",
      sourceName: "source",
      sourceRootPath: "../source",
      treeMode: "dedicated",
      treeRepoName: "tree",
    });

    const classifyResponses = [
      JSON.stringify([
        {
          path: "pkg-a",
          type: "TREE_MISS",
          target_node_path: null,
          rationale: "No node for pkg-a",
          suggested_node_title: "pkg-a",
          suggested_node_body_markdown: "# pkg-a",
        },
      ]),
      JSON.stringify([
        {
          path: "pkg-b",
          type: "TREE_MISS",
          target_node_path: null,
          rationale: "No node for pkg-b",
          suggested_node_title: "pkg-b",
          suggested_node_body_markdown: "# pkg-b",
        },
      ]),
    ];

    const { shellRun, captured } = makeRecordingShell(tmp.path, classifyResponses);

    const exitCode = await runSync(
      tmp.path,
      { source: undefined, propose: false, apply: true, dryRun: false },
      { shellRun, verifyTree: () => 0 },
    );

    const bodies = extractBodies(captured);
    const bodyHashes: Record<string, string> = {};
    for (const [k, v] of Object.entries(bodies)) bodyHashes[k] = hash(v);

    const nodeMdFiles: Record<string, string> = {};
    for (const dir of ["pkg-a", "pkg-b"]) {
      try {
        const p = join(tmp.path, dir, "NODE.md");
        nodeMdFiles[dir] = hash(readFileSync(p, "utf-8"));
      } catch {
        // node dir may not exist in all paths; record absence
        nodeMdFiles[dir] = "<absent>";
      }
    }

    const snapshot: Snapshot = {
      exitCode,
      calls: redact(captured, tmp.path),
      bodyHashes,
      nodeMdFiles,
    };

    if (process.env.UPDATE_SYNC_GOLDEN === "1") {
      mkdirSync(join(__dirname, "..", "fixtures", "sync-golden"), { recursive: true });
      writeFileSync(FIXTURE_PATH, JSON.stringify(snapshot, null, 2) + "\n");
      // eslint-disable-next-line no-console
      console.log(`[golden] wrote fixture: ${FIXTURE_PATH}`);
      return;
    }

    const expected: Snapshot = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));
    expect(snapshot).toEqual(expected);
  });
});
