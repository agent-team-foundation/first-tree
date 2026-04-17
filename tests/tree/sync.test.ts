import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  SYNC_USAGE,
  parseOwnerRepoFromRemoteUrl,
  runSync,
  runSyncCli,
  scanTreeNodes,
  type ShellResult,
  type ShellRun,
} from "#products/tree/engine/sync.js";
import {
  readTreeBinding,
  writeTreeBinding,
  type TreeBindingState,
} from "#products/tree/engine/runtime/binding-state.js";
import { makeTreeMetadata, useTmpDir } from "../helpers.js";

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
}

function okAuth(): ShellResult {
  return { stdout: "Logged in", stderr: "", code: 0 };
}

function claudeVersionOk(): ShellResult {
  return { stdout: "1.0.0", stderr: "", code: 0 };
}

function makeOkShellRun(
  responses: Record<string, ShellResult | ((args: string[]) => ShellResult)>,
): ShellRun {
  return async (command, args) => {
    if (command === "gh" && args[0] === "auth" && args[1] === "status") {
      return okAuth();
    }
    if (command === "claude" && args[0] === "--version") {
      return claudeVersionOk();
    }
    const key = `${command} ${args.join(" ")}`;
    const prefixKey = Object.keys(responses).find((candidate) => key.startsWith(candidate));
    if (prefixKey) {
      const value = responses[prefixKey];
      return typeof value === "function" ? value(args) : value;
    }
    return { stdout: "", stderr: `no mock for ${key}`, code: 1 };
  };
}

describe("sync -- parseOwnerRepoFromRemoteUrl", () => {
  it("parses https URL", () => {
    expect(parseOwnerRepoFromRemoteUrl("https://github.com/alice/example.git")).toEqual({
      owner: "alice",
      repo: "example",
    });
  });

  it("parses ssh URL", () => {
    expect(parseOwnerRepoFromRemoteUrl("git@github.com:alice/example.git")).toEqual({
      owner: "alice",
      repo: "example",
    });
  });

  it("returns null on garbage", () => {
    expect(parseOwnerRepoFromRemoteUrl("not-a-url")).toBeNull();
  });
});

describe("sync -- schema back/forward compat", () => {
  it("parses a v1 binding file (no lastReconciledSourceCommit)", () => {
    const tmp = useTmpDir();
    const bindingDir = join(tmp.path, ".first-tree", "bindings");
    mkdirSync(bindingDir, { recursive: true });
    const v1 = {
      bindingMode: "standalone-source",
      entrypoint: "/repos/source",
      rootKind: "git-repo",
      schemaVersion: 1,
      scope: "repo",
      sourceId: "source-aaa",
      sourceName: "source",
      sourceRootPath: "../source",
      treeMode: "dedicated",
      treeRepoName: "tree",
    };
    writeFileSync(join(bindingDir, "source-aaa.json"), JSON.stringify(v1, null, 2));
    const state = readTreeBinding(tmp.path, "source-aaa");
    expect(state).not.toBeNull();
    expect(state?.sourceId).toBe("source-aaa");
    expect(state?.lastReconciledSourceCommit).toBeUndefined();
    expect(state?.lastReconciledAt).toBeUndefined();
  });

  it("round-trips a v2 binding with sync fields", () => {
    const tmp = useTmpDir();
    const binding: Omit<TreeBindingState, "schemaVersion"> = {
      bindingMode: "standalone-source",
      entrypoint: "/repos/source",
      lastReconciledAt: "2026-04-10T00:00:00.000Z",
      lastReconciledSourceCommit: "deadbeefcafebabe1234567890abcdef12345678",
      remoteUrl: "https://github.com/alice/source.git",
      rootKind: "git-repo",
      scope: "repo",
      sourceId: "source-bbb",
      sourceName: "source",
      sourceRootPath: "../source",
      treeMode: "dedicated",
      treeRepoName: "tree",
    };
    writeTreeBinding(tmp.path, "source-bbb", binding);
    const read = readTreeBinding(tmp.path, "source-bbb");
    expect(read?.lastReconciledSourceCommit).toBe("deadbeefcafebabe1234567890abcdef12345678");
    expect(read?.lastReconciledAt).toBe("2026-04-10T00:00:00.000Z");
  });
});

describe("sync -- scanTreeNodes", () => {
  it("finds NODE.md files and parses frontmatter", () => {
    const tmp = useTmpDir();
    writeFileSync(
      join(tmp.path, "NODE.md"),
      "---\ntitle: Root\nowners: [alice, bob]\n---\n",
    );
    mkdirSync(join(tmp.path, "members", "alice"), { recursive: true });
    writeFileSync(
      join(tmp.path, "members", "NODE.md"),
      "---\ntitle: Members\nowners: [alice]\n---\n",
    );
    writeFileSync(
      join(tmp.path, "members", "alice", "NODE.md"),
      "---\ntitle: Alice\nowners: [alice]\n---\n",
    );
    // skip dirs
    mkdirSync(join(tmp.path, "node_modules", "foo"), { recursive: true });
    writeFileSync(join(tmp.path, "node_modules", "foo", "NODE.md"), "---\ntitle: X\n---\n");
    const nodes = scanTreeNodes(tmp.path);
    const paths = nodes.map((n) => n.path);
    expect(paths).toContain("NODE.md");
    expect(paths).toContain("members/NODE.md");
    expect(paths).toContain("members/alice/NODE.md");
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    const root = nodes.find((n) => n.path === "NODE.md");
    expect(root?.title).toBe("Root");
    expect(root?.owners).toEqual(["alice", "bob"]);
  });
});

describe("sync -- default run", () => {
  it("exits 0 on an empty tree with no bindings", async () => {
    const tmp = useTmpDir();
    makeTreeShell(tmp.path);
    const shellRun: ShellRun = async (command, args) => {
      if (command === "gh" && args[0] === "auth") return okAuth();
      if (command === "claude" && args[0] === "--version") return claudeVersionOk();
      return { stdout: "", stderr: "unexpected", code: 1 };
    };
    const code = await runSync(
      tmp.path,
      { source: undefined, propose: false, apply: false, dryRun: false },
      { shellRun },
    );
    expect(code).toBe(0);
  });

  it("missing claude CLI exits 1 with install instructions", async () => {
    const tmp = useTmpDir();
    makeTreeShell(tmp.path);
    const binding: Omit<TreeBindingState, "schemaVersion"> = {
      bindingMode: "standalone-source",
      entrypoint: "/repos/source",
      remoteUrl: "https://github.com/alice/source.git",
      rootKind: "git-repo",
      scope: "repo",
      sourceId: "source-111",
      sourceName: "source",
      sourceRootPath: "../source",
      treeMode: "dedicated",
      treeRepoName: "tree",
    };
    writeTreeBinding(tmp.path, "source-111", binding);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const shellRun: ShellRun = async (command, args) => {
      if (command === "gh" && args[0] === "auth") return okAuth();
      if (command === "claude" && args[0] === "--version") {
        return { stdout: "", stderr: "command not found", code: 127 };
      }
      return { stdout: "", stderr: "unexpected", code: 1 };
    };
    const code = await runSync(
      tmp.path,
      { source: undefined, propose: true, apply: false, dryRun: false },
      { shellRun },
    );
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("The `claude` CLI is required"),
    );
    errSpy.mockRestore();
  });

  it("first-run: generates proposals from history", async () => {
    const tmp = useTmpDir();
    makeTreeShell(tmp.path);
    const binding: Omit<TreeBindingState, "schemaVersion"> = {
      bindingMode: "standalone-source",
      entrypoint: "/repos/source",
      remoteUrl: "https://github.com/alice/source.git",
      rootKind: "git-repo",
      scope: "repo",
      sourceId: "source-111",
      sourceName: "source",
      sourceRootPath: "../source",
      treeMode: "dedicated",
      treeRepoName: "tree",
    };
    writeTreeBinding(tmp.path, "source-111", binding);
    const head = "aaaaaaabbbbbbbccccccc1111111222222233333";
    const firstCommitSha = "0000000111111122222223333333444444455555";
    const compareJson = JSON.stringify({
      commits: [
        {
          sha: "aaaaaaa1111111111111111111111111111aaaa",
          commit: {
            message: "feat(api): add endpoint\n\nbody",
            author: { name: "alice", date: "2026-04-01T00:00:00Z" },
          },
          files: [{ filename: "api/routes.ts" }],
        },
      ],
    });
    const classifyResponse = JSON.stringify([
      {
        path: "api",
        type: "TREE_MISS",
        target_node_path: null,
        rationale: "No tree node for api",
        suggested_node_title: "API",
        suggested_node_body_markdown: "# API\nNew endpoint",
      },
    ]);
    const shellRun: ShellRun = async (command, args) => {
      if (command === "gh" && args[0] === "auth") return okAuth();
      if (command === "claude" && args[0] === "--version") return claudeVersionOk();
      if (command === "gh" && args[0] === "api") {
        const path = args[1] ?? "";
        if (path.includes("/commits/HEAD")) {
          return { stdout: `${head}\n`, stderr: "", code: 0 };
        }
        if (path === `/repos/alice/source`) {
          return { stdout: JSON.stringify({ default_branch: "main" }), stderr: "", code: 0 };
        }
        if (path.includes("direction=asc")) {
          return { stdout: JSON.stringify([{ sha: firstCommitSha }]), stderr: "", code: 0 };
        }
        if (path.includes("page=500")) {
          return { stdout: JSON.stringify([]), stderr: "", code: 0 };
        }
        if (path.startsWith("/repos/alice/source/compare/")) {
          return { stdout: compareJson, stderr: "", code: 0 };
        }
        if (path.startsWith("search/issues")) {
          return { stdout: JSON.stringify({ items: [] }), stderr: "", code: 0 };
        }
      }
      if (command === "claude" && args[0] === "-p") {
        return { stdout: classifyResponse, stderr: "", code: 0 };
      }
      return { stdout: "", stderr: `unexpected ${command} ${args.join(" ")}`, code: 1 };
    };
    const now = () => new Date("2026-04-10T10:00:00.000Z");
    const code = await runSync(
      tmp.path,
      { source: undefined, propose: true, apply: false, dryRun: false },
      { shellRun, now },
    );
    expect(code).toBe(0);
    // First run should generate proposals, not just pin silently
    const proposalsDir = join(tmp.path, ".first-tree", "proposals", "source-111");
    expect(existsSync(proposalsDir)).toBe(true);
    const files = readdirSync(proposalsDir);
    expect(files.length).toBeGreaterThan(0);
    // On propose-only, binding should NOT be pinned
    const after = readTreeBinding(tmp.path, "source-111");
    expect(after?.lastReconciledSourceCommit).toBeUndefined();
  });

  it("stale + --propose: writes proposal files via claude classification", async () => {
    const tmp = useTmpDir();
    makeTreeShell(tmp.path);
    const fromSha = "11111111111111111111111111111111deadbeef";
    const toSha = "22222222222222222222222222222222cafebabe";
    writeTreeBinding(tmp.path, "source-222", {
      bindingMode: "standalone-source",
      entrypoint: "/repos/source",
      lastReconciledSourceCommit: fromSha,
      remoteUrl: "https://github.com/alice/source.git",
      rootKind: "git-repo",
      scope: "repo",
      sourceId: "source-222",
      sourceName: "source",
      sourceRootPath: "../source",
      treeMode: "dedicated",
      treeRepoName: "tree",
    });
    const compareJson = JSON.stringify({
      commits: [
        {
          sha: "aaaaaaa1111111111111111111111111111aaaa",
          commit: {
            message: "feat(api): add endpoint\n\nbody",
            author: { name: "alice", date: "2026-04-01T00:00:00Z" },
          },
          files: [{ filename: "api/routes.ts" }],
        },
        {
          sha: "bbbbbbb2222222222222222222222222222bbbb",
          commit: {
            message: "feat(web): add page",
            author: { name: "bob", date: "2026-04-02T00:00:00Z" },
          },
          files: [{ filename: "web/pages/home.tsx" }],
        },
        {
          sha: "ccccccc3333333333333333333333333333cccc",
          commit: {
            message: "chore(infra): bump deps",
            author: { name: "bob", date: "2026-04-03T00:00:00Z" },
          },
          files: [{ filename: "infra/terraform/main.tf" }],
        },
      ],
    });
    const classifyResponse = JSON.stringify([
      {
        path: "api",
        type: "TREE_MISS",
        target_node_path: null,
        rationale: "No tree node for api",
        suggested_node_title: "API",
        suggested_node_body_markdown: "# API\nNew endpoint",
      },
      {
        path: "web",
        type: "TREE_MISS",
        target_node_path: null,
        rationale: "No tree node for web",
        suggested_node_title: "Web",
        suggested_node_body_markdown: "# Web\nNew page",
      },
      {
        path: "infra",
        type: "TREE_MISS",
        target_node_path: null,
        rationale: "No tree node for infra",
        suggested_node_title: "Infra",
        suggested_node_body_markdown: "# Infra\nDeps bumped",
      },
    ]);
    const shellRun: ShellRun = async (command, args) => {
      if (command === "gh" && args[0] === "auth") return okAuth();
      if (command === "claude" && args[0] === "--version") return claudeVersionOk();
      if (command === "gh" && args[0] === "api") {
        const path = args[1] ?? "";
        if (path === "/repos/alice/source/commits/HEAD") {
          return { stdout: `${toSha}\n`, stderr: "", code: 0 };
        }
        if (path.startsWith("/repos/alice/source/compare/")) {
          return { stdout: compareJson, stderr: "", code: 0 };
        }
        if (path.startsWith("search/issues")) {
          return { stdout: JSON.stringify({ items: [] }), stderr: "", code: 0 };
        }
      }
      if (command === "claude" && args[0] === "-p") {
        return { stdout: classifyResponse, stderr: "", code: 0 };
      }
      return { stdout: "", stderr: `unexpected ${command} ${args.join(" ")}`, code: 1 };
    };
    const code = await runSync(
      tmp.path,
      { source: undefined, propose: true, apply: false, dryRun: false },
      { shellRun },
    );
    expect(code).toBe(0);
    const proposalsDir = join(tmp.path, ".first-tree", "proposals", "source-222");
    expect(existsSync(proposalsDir)).toBe(true);
    const files = readdirSync(proposalsDir);
    expect(files.length).toBe(3);
    for (const file of files) {
      const content = readFileSync(join(proposalsDir, file), "utf-8");
      expect(content).toContain("type: TREE_MISS");
      expect(content).toContain(`source_id: source-222`);
    }
    // binding pin should NOT be bumped on --propose only
    const after = readTreeBinding(tmp.path, "source-222");
    expect(after?.lastReconciledSourceCommit).toBe(fromSha);
  });
});

describe("sync -- PR labeling", () => {
  it("apply prepares every sync branch from the original ref", async () => {
    const tmp = useTmpDir();
    makeTreeShell(tmp.path);
    mkdirSync(join(tmp.path, ".github"), { recursive: true });
    writeFileSync(
      join(tmp.path, ".github", "CODEOWNERS"),
      "/pkg-a/ @alice\n/pkg-b/ @bob\n",
    );
    const fromSha = "aa".repeat(20);
    const toSha = "bb".repeat(20);
    writeTreeBinding(tmp.path, "source-parallel", {
      bindingMode: "standalone-source",
      entrypoint: "/repos/source",
      lastReconciledSourceCommit: fromSha,
      remoteUrl: "https://github.com/alice/source.git",
      rootKind: "git-repo",
      scope: "repo",
      sourceId: "source-parallel",
      sourceName: "source",
      sourceRootPath: "../source",
      treeMode: "dedicated",
      treeRepoName: "tree",
    });
    const checkoutCommands: string[][] = [];
    let classifyCall = 0;
    const shellRun: ShellRun = async (command, args) => {
      if (command === "gh" && args[0] === "auth") return okAuth();
      if (command === "claude" && args[0] === "--version") return claudeVersionOk();
      if (command === "gh" && args[0] === "api") {
        const path = args[1] ?? "";
        if (path === "/repos/alice/source/commits/HEAD") {
          return { stdout: `${toSha}\n`, stderr: "", code: 0 };
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
      if (command === "gh" && args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]", stderr: "", code: 0 };
      }
      if (command === "claude" && args[0] === "-p") {
        classifyCall += 1;
        return {
          stdout: JSON.stringify([
            classifyCall === 1
              ? {
                  path: "pkg-a",
                  type: "TREE_MISS",
                  target_node_path: null,
                  rationale: "No node for pkg-a",
                  suggested_node_title: "pkg-a",
                  suggested_node_body_markdown: "# pkg-a",
                }
              : {
                  path: "pkg-b",
                  type: "TREE_MISS",
                  target_node_path: null,
                  rationale: "No node for pkg-b",
                  suggested_node_title: "pkg-b",
                  suggested_node_body_markdown: "# pkg-b",
                },
          ]),
          stderr: "",
          code: 0,
        };
      }
      if (command === "git") {
        if (args[0] === "symbolic-ref") {
          return { stdout: "main\n", stderr: "", code: 0 };
        }
        if (args[0] === "checkout") {
          checkoutCommands.push([...args]);
          return { stdout: "", stderr: "", code: 0 };
        }
        if (args.includes("diff") && args.includes("--cached") && args.includes("--quiet")) {
          return { stdout: "", stderr: "", code: 1 };
        }
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: `no mock for ${command} ${args.join(" ")}`, code: 1 };
    };
    const code = await runSync(
      tmp.path,
      { source: undefined, propose: false, apply: true, dryRun: true },
      { shellRun, verifyTree: () => 0 },
    );
    expect(code).toBe(0);
    expect(checkoutCommands).toEqual([
      ["checkout", "-B", "first-tree/sync-source-parallel-pr101", "main"],
      ["checkout", "-B", "first-tree/sync-source-parallel-pr102", "main"],
      ["checkout", "main"],
    ]);
  });

  it("does not open housekeeping after a partial parallel apply failure", async () => {
    const tmp = useTmpDir();
    makeTreeShell(tmp.path);
    mkdirSync(join(tmp.path, ".github"), { recursive: true });
    writeFileSync(
      join(tmp.path, ".github", "CODEOWNERS"),
      "/pkg-a/ @alice\n/pkg-b/ @bob\n",
    );
    const fromSha = "aa".repeat(20);
    const toSha = "bb".repeat(20);
    writeTreeBinding(tmp.path, "source-parallel", {
      bindingMode: "standalone-source",
      entrypoint: "/repos/source",
      lastReconciledSourceCommit: fromSha,
      remoteUrl: "https://github.com/alice/source.git",
      rootKind: "git-repo",
      scope: "repo",
      sourceId: "source-parallel",
      sourceName: "source",
      sourceRootPath: "../source",
      treeMode: "dedicated",
      treeRepoName: "tree",
    });
    const prCreateCalls: string[][] = [];
    let classifyCall = 0;
    const shellRun: ShellRun = async (command, args) => {
      if (command === "gh" && args[0] === "auth") return okAuth();
      if (command === "claude" && args[0] === "--version") return claudeVersionOk();
      if (command === "gh" && args[0] === "api") {
        const path = args[1] ?? "";
        if (path === "/repos/alice/source/commits/HEAD") {
          return { stdout: `${toSha}\n`, stderr: "", code: 0 };
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
      if (command === "gh" && args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]", stderr: "", code: 0 };
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "create") {
        prCreateCalls.push([...args]);
        return { stdout: "https://github.com/x/y/pull/101\n", stderr: "", code: 0 };
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "edit") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "gh" && args[0] === "label") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "claude" && args[0] === "-p") {
        classifyCall += 1;
        return {
          stdout: JSON.stringify([
            classifyCall === 1
              ? {
                  path: "pkg-a",
                  type: "TREE_MISS",
                  target_node_path: null,
                  rationale: "No node for pkg-a",
                  suggested_node_title: "pkg-a",
                  suggested_node_body_markdown: "# pkg-a",
                }
              : {
                  path: "pkg-b",
                  type: "TREE_MISS",
                  target_node_path: null,
                  rationale: "No node for pkg-b",
                  suggested_node_title: "pkg-b",
                  suggested_node_body_markdown: "# pkg-b",
                },
          ]),
          stderr: "",
          code: 0,
        };
      }
      if (command === "git") {
        if (args[0] === "symbolic-ref") {
          return { stdout: "main\n", stderr: "", code: 0 };
        }
        if (args[0] === "checkout") {
          return { stdout: "", stderr: "", code: 0 };
        }
        if (args[0] === "push" && args[2] === "first-tree/sync-source-parallel-pr102") {
          return { stdout: "", stderr: "push failed", code: 1 };
        }
        if (args.includes("diff") && args.includes("--cached") && args.includes("--quiet")) {
          return { stdout: "", stderr: "", code: 1 };
        }
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: `no mock for ${command} ${args.join(" ")}`, code: 1 };
    };

    const code = await runSync(
      tmp.path,
      { source: undefined, propose: false, apply: true, dryRun: false },
      { shellRun, verifyTree: () => 0 },
    );

    expect(code).toBe(1);
    expect(readTreeBinding(tmp.path, "source-parallel")?.lastReconciledSourceCommit).toBe(fromSha);
    expect(
      prCreateCalls.some((args) => args.includes("chore(sync): housekeeping for source-parallel")),
    ).toBe(false);
  });

  it("apply labels PR with first-tree:sync only, never auto-merge", async () => {
    const tmp = useTmpDir();
    makeTreeShell(tmp.path);
    mkdirSync(join(tmp.path, ".github"), { recursive: true });
    writeFileSync(
      join(tmp.path, ".github", "CODEOWNERS"),
      "/pkg-a/ @alice @bob\n",
    );
    const fromSha = "aa".repeat(20);
    const toSha = "bb".repeat(20);
    writeTreeBinding(tmp.path, "source-label", {
      bindingMode: "standalone-source",
      entrypoint: "/repos/source",
      lastReconciledSourceCommit: fromSha,
      remoteUrl: "https://github.com/alice/source.git",
      rootKind: "git-repo",
      scope: "repo",
      sourceId: "source-label",
      sourceName: "source",
      sourceRootPath: "../source",
      treeMode: "dedicated",
      treeRepoName: "tree",
    });
    const classifyResponse = JSON.stringify([
      {
        path: "pkg-a",
        type: "TREE_MISS",
        target_node_path: null,
        rationale: "No node for pkg-a",
        suggested_node_title: "pkg-a",
        suggested_node_body_markdown: "# pkg-a",
      },
    ]);
    let labelArgsCaptured: string[] = [];
    const shellRun: ShellRun = async (command, args) => {
      if (command === "gh" && args[0] === "auth") return okAuth();
      if (command === "claude" && args[0] === "--version") return claudeVersionOk();
      if (command === "gh" && args[0] === "api") {
        const path = args[1] ?? "";
        if (path === "/repos/alice/source/commits/HEAD") {
          return { stdout: `${toSha}\n`, stderr: "", code: 0 };
        }
        if (path.startsWith("/repos/alice/source/compare/")) {
          return {
            stdout: JSON.stringify({
              commits: [{
                sha: "1".repeat(40),
                commit: { message: "feat: thing", author: { name: "a", date: "2026-04-01T00:00:00Z" } },
                files: [{ filename: "pkg-a/x.ts" }],
              }],
            }),
            stderr: "",
            code: 0,
          };
        }
        if (path.startsWith("search/issues")) {
          return { stdout: JSON.stringify({ items: [] }), stderr: "", code: 0 };
        }
      }
      if (command === "claude" && args[0] === "-p") {
        return { stdout: classifyResponse, stderr: "", code: 0 };
      }
      if (command === "git") {
        if (args[0] === "symbolic-ref") {
          return { stdout: "main\n", stderr: "", code: 0 };
        }
        // diff --cached --quiet: exit 1 = has staged changes (simulate successful staging)
        if (args.includes("diff") && args.includes("--cached") && args.includes("--quiet")) {
          return { stdout: "", stderr: "", code: 1 };
        }
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "create") {
        return { stdout: "https://github.com/x/y/pull/99", stderr: "", code: 0 };
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "edit") {
        labelArgsCaptured = [...args];
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: `no mock for ${command} ${args.join(" ")}`, code: 1 };
    };
    const code = await runSync(
      tmp.path,
      { source: undefined, propose: false, apply: true, dryRun: false },
      { shellRun, verifyTree: () => 0 },
    );
    expect(code).toBe(0);
    expect(labelArgsCaptured.join(" ")).toContain("first-tree:sync");
    expect(labelArgsCaptured.join(" ")).not.toContain("auto-merge");
    const nodeText = readFileSync(join(tmp.path, "pkg-a", "NODE.md"), "utf-8");
    expect(nodeText).toContain("owners: [alice]");
    expect(nodeText).not.toContain("@alice");
  });

  it("emits soft_links frontmatter when Claude returns cross-domain references (#124)", async () => {
    const tmp = useTmpDir();
    makeTreeShell(tmp.path);
    const fromSha = "aa".repeat(20);
    const toSha = "bb".repeat(20);
    writeTreeBinding(tmp.path, "source-softlinks", {
      bindingMode: "standalone-source",
      entrypoint: "/repos/source",
      lastReconciledSourceCommit: fromSha,
      remoteUrl: "https://github.com/alice/source.git",
      rootKind: "git-repo",
      scope: "repo",
      sourceId: "source-softlinks",
      sourceName: "source",
      sourceRootPath: "../source",
      treeMode: "dedicated",
      treeRepoName: "tree",
    });
    const shellRun: ShellRun = async (command, args) => {
      if (command === "gh" && args[0] === "auth") return okAuth();
      if (command === "claude" && args[0] === "--version") return claudeVersionOk();
      if (command === "gh" && args[0] === "api") {
        const path = args[1] ?? "";
        if (path === "/repos/alice/source/commits/HEAD") {
          return { stdout: `${toSha}\n`, stderr: "", code: 0 };
        }
        if (path.startsWith("/repos/alice/source/compare/")) {
          return {
            stdout: JSON.stringify({
              commits: [{
                sha: "1".repeat(40),
                commit: { message: "feat(mcp): add server (#401)", author: { name: "a", date: "2026-04-01T00:00:00Z" } },
                files: [{ filename: "mcp/server.ts" }],
              }],
            }),
            stderr: "",
            code: 0,
          };
        }
        if (path.startsWith("search/issues")) {
          return {
            stdout: JSON.stringify({
              items: [{
                number: 401,
                title: "feat(mcp): add server",
                pull_request: { merged_at: "2026-04-01T00:00:00Z", merge_commit_sha: "1".repeat(40) },
              }],
            }),
            stderr: "",
            code: 0,
          };
        }
      }
      if (command === "claude" && args[0] === "-p") {
        return {
          stdout: JSON.stringify([{
            path: "mcp",
            type: "TREE_MISS",
            target_node_path: null,
            rationale: "New MCP area",
            suggested_node_title: "MCP",
            suggested_node_body_markdown: "# MCP\nUses governance/ rules and backend/ transport.",
            suggested_soft_links: ["governance", "backend", "governance", "mcp"],
          }]),
          stderr: "",
          code: 0,
        };
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]", stderr: "", code: 0 };
      }
      if (command === "git") {
        if (args[0] === "symbolic-ref") return { stdout: "main\n", stderr: "", code: 0 };
        if (args.includes("diff") && args.includes("--cached") && args.includes("--quiet")) {
          return { stdout: "", stderr: "", code: 1 };
        }
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: `no mock for ${command} ${args.join(" ")}`, code: 1 };
    };
    const code = await runSync(
      tmp.path,
      { source: undefined, propose: false, apply: true, dryRun: true },
      { shellRun, verifyTree: () => 0 },
    );
    expect(code).toBe(0);
    const nodeText = readFileSync(join(tmp.path, "mcp", "NODE.md"), "utf-8");
    // soft_links must be present, sorted, deduped, and must not include the
    // target's own path ("mcp").
    expect(nodeText).toMatch(/soft_links: \[backend, governance\]/);
    expect(nodeText).not.toMatch(/soft_links:[^\n]*mcp/);
  });

  it("drops TREE_SUPPLEMENT items instead of advertising unapplied edits (#125)", async () => {
    const tmp = useTmpDir();
    makeTreeShell(tmp.path);
    // Seed an existing node that a supplement item would target.
    mkdirSync(join(tmp.path, "backend"), { recursive: true });
    writeFileSync(
      join(tmp.path, "backend", "NODE.md"),
      "---\ntitle: \"Backend\"\nowners: [@alice]\n---\n\nHand-authored.\n",
    );
    const fromSha = "aa".repeat(20);
    const toSha = "bb".repeat(20);
    writeTreeBinding(tmp.path, "source-supplement", {
      bindingMode: "standalone-source",
      entrypoint: "/repos/source",
      lastReconciledSourceCommit: fromSha,
      remoteUrl: "https://github.com/alice/source.git",
      rootKind: "git-repo",
      scope: "repo",
      sourceId: "source-supplement",
      sourceName: "source",
      sourceRootPath: "../source",
      treeMode: "dedicated",
      treeRepoName: "tree",
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const shellRun: ShellRun = async (command, args) => {
      if (command === "gh" && args[0] === "auth") return okAuth();
      if (command === "claude" && args[0] === "--version") return claudeVersionOk();
      if (command === "gh" && args[0] === "api") {
        const path = args[1] ?? "";
        if (path === "/repos/alice/source/commits/HEAD") {
          return { stdout: `${toSha}\n`, stderr: "", code: 0 };
        }
        if (path.startsWith("/repos/alice/source/compare/")) {
          return {
            stdout: JSON.stringify({
              commits: [{
                sha: "1".repeat(40),
                commit: { message: "feat(api): ratelimits (#501)", author: { name: "a", date: "2026-04-01T00:00:00Z" } },
                files: [{ filename: "api/ratelimit.ts" }],
              }],
            }),
            stderr: "",
            code: 0,
          };
        }
        if (path.startsWith("search/issues")) {
          return {
            stdout: JSON.stringify({
              items: [{
                number: 501,
                title: "feat(api): ratelimits",
                pull_request: { merged_at: "2026-04-01T00:00:00Z", merge_commit_sha: "1".repeat(40) },
              }],
            }),
            stderr: "",
            code: 0,
          };
        }
      }
      if (command === "claude" && args[0] === "-p") {
        return {
          stdout: JSON.stringify([
            {
              path: "api/ratelimits",
              type: "TREE_MISS",
              rationale: "New rate-limit subsystem",
              suggested_node_title: "API ratelimits",
              suggested_node_body_markdown: "# Ratelimits\nBody.",
            },
            {
              path: "backend",
              type: "TREE_SUPPLEMENT",
              rationale: "Existing backend node should mention rate limits too",
              suggested_node_title: "Backend",
              suggested_node_body_markdown: "Supplement content that would rewrite Backend.",
            },
          ]),
          stderr: "",
          code: 0,
        };
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]", stderr: "", code: 0 };
      }
      if (command === "git") {
        if (args[0] === "symbolic-ref") return { stdout: "main\n", stderr: "", code: 0 };
        if (args.includes("diff") && args.includes("--cached") && args.includes("--quiet")) {
          return { stdout: "", stderr: "", code: 1 };
        }
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: `no mock for ${command} ${args.join(" ")}`, code: 1 };
    };
    const code = await runSync(
      tmp.path,
      { source: undefined, propose: false, apply: true, dryRun: true },
      { shellRun, verifyTree: () => 0 },
    );
    expect(code).toBe(0);
    // TREE_MISS proposal produced a new NODE.md.
    expect(existsSync(join(tmp.path, "api", "ratelimits", "NODE.md"))).toBe(true);
    // Existing backend NODE.md is preserved byte-for-byte (no supplement applied).
    const backendText = readFileSync(join(tmp.path, "backend", "NODE.md"), "utf-8");
    expect(backendText).toBe(
      "---\ntitle: \"Backend\"\nowners: [@alice]\n---\n\nHand-authored.\n",
    );
    // Sync logged that it dropped the unsupported TREE_SUPPLEMENT item.
    const logs = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logs).toMatch(/dropping unsupported classification type "TREE_SUPPLEMENT"/);
    logSpy.mockRestore();
  });

  it("feeds truncated diff hunks and filters lockfile noise in the classification prompt (#123)", async () => {
    const tmp = useTmpDir();
    makeTreeShell(tmp.path);
    const fromSha = "aa".repeat(20);
    const toSha = "bb".repeat(20);
    writeTreeBinding(tmp.path, "source-diff", {
      bindingMode: "standalone-source",
      entrypoint: "/repos/source",
      lastReconciledSourceCommit: fromSha,
      remoteUrl: "https://github.com/alice/source.git",
      rootKind: "git-repo",
      scope: "repo",
      sourceId: "source-diff",
      sourceName: "source",
      sourceRootPath: "../source",
      treeMode: "dedicated",
      treeRepoName: "tree",
    });
    let capturedPrompt = "";
    const shellRun: ShellRun = async (command, args) => {
      if (command === "gh" && args[0] === "auth") return okAuth();
      if (command === "claude" && args[0] === "--version") return claudeVersionOk();
      if (command === "gh" && args[0] === "api") {
        const path = args[1] ?? "";
        if (path === "/repos/alice/source/commits/HEAD") {
          return { stdout: `${toSha}\n`, stderr: "", code: 0 };
        }
        if (path.startsWith("/repos/alice/source/compare/")) {
          return {
            stdout: JSON.stringify({
              commits: [{
                sha: "1".repeat(40),
                commit: { message: "feat: add oauth (#301)", author: { name: "a", date: "2026-04-01T00:00:00Z" } },
                files: [{ filename: "auth/oauth.ts" }],
              }],
            }),
            stderr: "",
            code: 0,
          };
        }
        if (path.startsWith("search/issues")) {
          return {
            stdout: JSON.stringify({
              items: [{
                number: 301,
                title: "feat: add oauth",
                pull_request: { merged_at: "2026-04-01T00:00:00Z", merge_commit_sha: "1".repeat(40) },
              }],
            }),
            stderr: "",
            code: 0,
          };
        }
        if (path.includes("/pulls/301/files")) {
          return {
            stdout: JSON.stringify([
              {
                filename: "auth/oauth.ts",
                status: "added",
                patch: "@@ -0,0 +1,3 @@\n+export function oauthLogin(code: string) {\n+  return fetch('/oauth/callback?code=' + code);\n+}",
              },
              {
                filename: "pnpm-lock.yaml",
                status: "modified",
                patch: "@@ -1,5000 +1,5050 @@\n(massive lockfile churn)",
              },
            ]),
            stderr: "",
            code: 0,
          };
        }
      }
      if (command === "claude" && args[0] === "-p") {
        capturedPrompt = args.at(-1) ?? "";
        return {
          stdout: JSON.stringify([]),
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", stderr: `no mock for ${command} ${args.join(" ")}`, code: 1 };
    };
    const code = await runSync(
      tmp.path,
      { source: undefined, propose: true, apply: false, dryRun: false },
      { shellRun },
    );
    expect(code).toBe(0);
    expect(capturedPrompt).toContain("Truncated diff hunks");
    expect(capturedPrompt).toContain("oauthLogin");
    expect(capturedPrompt).toContain("auth/oauth.ts");
    // Lockfile hunks must be filtered out of the diff section (filename is
    // still allowed in the Changed-files list — that's a cheap signal).
    const diffSection = capturedPrompt.split("Truncated diff hunks")[1] ?? "";
    expect(diffSection).not.toContain("pnpm-lock.yaml");
    expect(diffSection).not.toContain("massive lockfile churn");
  });

  it("dedups duplicate-path proposals, keeps strongest, credits others (#121)", async () => {
    const tmp = useTmpDir();
    makeTreeShell(tmp.path);
    const fromSha = "aa".repeat(20);
    const toSha = "bb".repeat(20);
    writeTreeBinding(tmp.path, "source-dedup", {
      bindingMode: "standalone-source",
      entrypoint: "/repos/source",
      lastReconciledSourceCommit: fromSha,
      remoteUrl: "https://github.com/alice/source.git",
      rootKind: "git-repo",
      scope: "repo",
      sourceId: "source-dedup",
      sourceName: "source",
      sourceRootPath: "../source",
      treeMode: "dedicated",
      treeRepoName: "tree",
    });
    const shortBody = "# MCP\nshort.";
    const longBody = "# MCP\n" + "Detailed bootstrap, auth, and routing notes. ".repeat(20);
    const prCreateCalls: string[][] = [];
    const checkoutBranches: string[] = [];
    let classifyCall = 0;
    const shellRun: ShellRun = async (command, args) => {
      if (command === "gh" && args[0] === "auth") return okAuth();
      if (command === "claude" && args[0] === "--version") return claudeVersionOk();
      if (command === "gh" && args[0] === "api") {
        const path = args[1] ?? "";
        if (path === "/repos/alice/source/commits/HEAD") {
          return { stdout: `${toSha}\n`, stderr: "", code: 0 };
        }
        if (path.startsWith("/repos/alice/source/compare/")) {
          return {
            stdout: JSON.stringify({
              commits: [
                {
                  sha: "1".repeat(40),
                  commit: { message: "feat(mcp): start (#201)", author: { name: "a", date: "2026-04-01T00:00:00Z" } },
                  files: [{ filename: "engineering/mcp/a.ts" }],
                },
                {
                  sha: "2".repeat(40),
                  commit: { message: "feat(mcp): more (#202)", author: { name: "b", date: "2026-04-02T00:00:00Z" } },
                  files: [{ filename: "engineering/mcp/b.ts" }],
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
                  number: 201,
                  title: "feat(mcp): start",
                  pull_request: { merged_at: "2026-04-01T00:00:00Z", merge_commit_sha: "1".repeat(40) },
                },
                {
                  number: 202,
                  title: "feat(mcp): more",
                  pull_request: { merged_at: "2026-04-02T00:00:00Z", merge_commit_sha: "2".repeat(40) },
                },
              ],
            }),
            stderr: "",
            code: 0,
          };
        }
      }
      if (command === "claude" && args[0] === "-p") {
        classifyCall += 1;
        // First PR (#201) gets the SHORT body, second PR (#202) gets LONG.
        const body = classifyCall === 1 ? shortBody : longBody;
        return {
          stdout: JSON.stringify([{
            path: "engineering/mcp",
            type: "TREE_MISS",
            target_node_path: null,
            rationale: "Claude picked mcp",
            suggested_node_title: "MCP",
            suggested_node_body_markdown: body,
          }]),
          stderr: "",
          code: 0,
        };
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]", stderr: "", code: 0 };
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "create") {
        prCreateCalls.push([...args]);
        return { stdout: "https://github.com/x/y/pull/1\n", stderr: "", code: 0 };
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "edit") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "gh" && args[0] === "label") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "git") {
        if (args[0] === "symbolic-ref") return { stdout: "main\n", stderr: "", code: 0 };
        if (args[0] === "checkout" && args[1] === "-B") {
          checkoutBranches.push(args[2]);
          return { stdout: "", stderr: "", code: 0 };
        }
        if (args.includes("diff") && args.includes("--cached") && args.includes("--quiet")) {
          return { stdout: "", stderr: "", code: 1 };
        }
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: `no mock for ${command} ${args.join(" ")}`, code: 1 };
    };
    const code = await runSync(
      tmp.path,
      { source: undefined, propose: false, apply: true, dryRun: false },
      { shellRun, verifyTree: () => 0 },
    );
    expect(code).toBe(0);

    // Exactly ONE content branch should be created for engineering/mcp, not two.
    const contentBranches = checkoutBranches.filter((b) => b.includes("sync-source-dedup-pr"));
    expect(contentBranches).toEqual(["first-tree/sync-source-dedup-pr202"]);

    // The surviving PR body must credit the dropped PR (#201).
    const contentPrCreate = prCreateCalls.find((args) =>
      args.some((a) => typeof a === "string" && a.includes("from alice/source#202")),
    );
    expect(contentPrCreate).toBeDefined();
    const bodyArg = contentPrCreate?.[contentPrCreate.indexOf("--body") + 1] ?? "";
    expect(bodyArg).toContain("also identified by #201");
  });

  it("creates a Sub-domains section on parent NODE.md when missing (#122)", async () => {
    const tmp = useTmpDir();
    makeTreeShell(tmp.path);
    mkdirSync(join(tmp.path, "engineering"), { recursive: true });
    writeFileSync(
      join(tmp.path, "engineering", "NODE.md"),
      "---\ntitle: Engineering\nowners: [alice]\n---\n# Engineering\n\nSome intro text.\n",
    );
    const fromSha = "aa".repeat(20);
    const toSha = "bb".repeat(20);
    writeTreeBinding(tmp.path, "source-parent", {
      bindingMode: "standalone-source",
      entrypoint: "/repos/source",
      lastReconciledSourceCommit: fromSha,
      remoteUrl: "https://github.com/alice/source.git",
      rootKind: "git-repo",
      scope: "repo",
      sourceId: "source-parent",
      sourceName: "source",
      sourceRootPath: "../source",
      treeMode: "dedicated",
      treeRepoName: "tree",
    });
    const shellRun: ShellRun = async (command, args) => {
      if (command === "gh" && args[0] === "auth") return okAuth();
      if (command === "claude" && args[0] === "--version") return claudeVersionOk();
      if (command === "gh" && args[0] === "api") {
        const path = args[1] ?? "";
        if (path === "/repos/alice/source/commits/HEAD") {
          return { stdout: `${toSha}\n`, stderr: "", code: 0 };
        }
        if (path.startsWith("/repos/alice/source/compare/")) {
          return {
            stdout: JSON.stringify({
              commits: [{
                sha: "1".repeat(40),
                commit: {
                  message: "feat(mcp): bootstrap server (#201)",
                  author: { name: "alice", date: "2026-04-01T00:00:00Z" },
                },
                files: [{ filename: "engineering/mcp/server.ts" }],
              }],
            }),
            stderr: "",
            code: 0,
          };
        }
        if (path.startsWith("search/issues")) {
          return {
            stdout: JSON.stringify({
              items: [{
                number: 201,
                title: "feat(mcp): bootstrap server",
                pull_request: {
                  merged_at: "2026-04-01T00:00:00Z",
                  merge_commit_sha: "1".repeat(40),
                },
              }],
            }),
            stderr: "",
            code: 0,
          };
        }
      }
      if (command === "claude" && args[0] === "-p") {
        return {
          stdout: JSON.stringify([{
            path: "engineering/mcp",
            type: "TREE_MISS",
            target_node_path: null,
            rationale: "New MCP area not in tree",
            suggested_node_title: "MCP",
            suggested_node_body_markdown: "# MCP\nBootstrap details.",
          }]),
          stderr: "",
          code: 0,
        };
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]", stderr: "", code: 0 };
      }
      if (command === "git") {
        if (args[0] === "symbolic-ref") {
          return { stdout: "main\n", stderr: "", code: 0 };
        }
        if (args.includes("diff") && args.includes("--cached") && args.includes("--quiet")) {
          return { stdout: "", stderr: "", code: 1 };
        }
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: `no mock for ${command} ${args.join(" ")}`, code: 1 };
    };
    const code = await runSync(
      tmp.path,
      { source: undefined, propose: false, apply: true, dryRun: true },
      { shellRun, verifyTree: () => 0 },
    );
    expect(code).toBe(0);

    const parentText = readFileSync(join(tmp.path, "engineering", "NODE.md"), "utf-8");
    expect(parentText).toMatch(/## Sub-domains/);
    expect(parentText).toContain("`mcp/`");
    expect(parentText).toContain("MCP");
  });

  it("regenerates and stages CODEOWNERS inside each content PR (#119)", async () => {
    const tmp = useTmpDir();
    makeTreeShell(tmp.path);
    mkdirSync(join(tmp.path, ".github"), { recursive: true });
    writeFileSync(
      join(tmp.path, ".github", "CODEOWNERS"),
      "# stale\n/old/ @nobody\n",
    );
    const fromSha = "aa".repeat(20);
    const toSha = "bb".repeat(20);
    writeTreeBinding(tmp.path, "source-codeowners", {
      bindingMode: "standalone-source",
      entrypoint: "/repos/source",
      lastReconciledSourceCommit: fromSha,
      remoteUrl: "https://github.com/alice/source.git",
      rootKind: "git-repo",
      scope: "repo",
      sourceId: "source-codeowners",
      sourceName: "source",
      sourceRootPath: "../source",
      treeMode: "dedicated",
      treeRepoName: "tree",
    });
    const gitAddCalls: string[][] = [];
    const commitCalls: string[][] = [];
    const prCreateCalls: string[][] = [];
    const shellRun: ShellRun = async (command, args) => {
      if (command === "gh" && args[0] === "auth") return okAuth();
      if (command === "claude" && args[0] === "--version") return claudeVersionOk();
      if (command === "gh" && args[0] === "api") {
        const path = args[1] ?? "";
        if (path === "/repos/alice/source/commits/HEAD") {
          return { stdout: `${toSha}\n`, stderr: "", code: 0 };
        }
        if (path.startsWith("/repos/alice/source/compare/")) {
          return {
            stdout: JSON.stringify({
              commits: [{
                sha: "1".repeat(40),
                commit: {
                  message: "feat(pkg-a): add thing (#101)",
                  author: { name: "alice", date: "2026-04-01T00:00:00Z" },
                },
                files: [{ filename: "pkg-a/x.ts" }],
              }],
            }),
            stderr: "",
            code: 0,
          };
        }
        if (path.startsWith("search/issues")) {
          return {
            stdout: JSON.stringify({
              items: [{
                number: 101,
                title: "feat(pkg-a): add thing",
                pull_request: {
                  merged_at: "2026-04-01T00:00:00Z",
                  merge_commit_sha: "1".repeat(40),
                },
              }],
            }),
            stderr: "",
            code: 0,
          };
        }
      }
      if (command === "claude" && args[0] === "-p") {
        return {
          stdout: JSON.stringify([{
            path: "pkg-a",
            type: "TREE_MISS",
            target_node_path: null,
            rationale: "No node for pkg-a",
            suggested_node_title: "pkg-a",
            suggested_node_body_markdown: "# pkg-a",
          }]),
          stderr: "",
          code: 0,
        };
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]", stderr: "", code: 0 };
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "create") {
        prCreateCalls.push([...args]);
        return { stdout: "https://github.com/x/y/pull/1\n", stderr: "", code: 0 };
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
        if (args[0] === "add") {
          gitAddCalls.push([...args]);
          return { stdout: "", stderr: "", code: 0 };
        }
        if (args[0] === "commit") {
          commitCalls.push([...args]);
          return { stdout: "", stderr: "", code: 0 };
        }
        if (args.includes("diff") && args.includes("--cached") && args.includes("--quiet")) {
          return { stdout: "", stderr: "", code: 1 };
        }
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: `no mock for ${command} ${args.join(" ")}`, code: 1 };
    };
    const code = await runSync(
      tmp.path,
      { source: undefined, propose: false, apply: true, dryRun: false },
      { shellRun, verifyTree: () => 0 },
    );
    expect(code).toBe(0);

    // Content PR must stage both the new NODE.md and the regenerated CODEOWNERS.
    const contentAddTargets = gitAddCalls
      .filter((args) => args[0] === "add" && args[1] !== "-A")
      .map((args) => args[1] ?? "");
    expect(contentAddTargets.some((p) => p.endsWith("/pkg-a/NODE.md"))).toBe(true);
    expect(contentAddTargets.some((p) => p.endsWith("/.github/CODEOWNERS"))).toBe(true);

    // CODEOWNERS on disk must reflect the new owners, not the stale seed.
    const codeowners = readFileSync(join(tmp.path, ".github", "CODEOWNERS"), "utf-8");
    expect(codeowners).toContain("Auto-generated from Context Tree");
    expect(codeowners).toContain("/pkg-a/");
    expect(codeowners).toContain("@alice");
    expect(codeowners).not.toContain("@nobody");

    // Housekeeping PR must no longer advertise CODEOWNERS work.
    const housekeepingCommit = commitCalls.find((args) =>
      args.some((a) => typeof a === "string" && a.startsWith("chore(sync): pin source-codeowners")),
    );
    expect(housekeepingCommit).toBeDefined();
    expect(housekeepingCommit?.join(" ")).not.toContain("regenerate CODEOWNERS");
    const housekeepingPr = prCreateCalls.find((args) =>
      args.some((a) => typeof a === "string" && a.includes("housekeeping for source-codeowners")),
    );
    expect(housekeepingPr).toBeDefined();
    const hkBody = housekeepingPr?.[housekeepingPr.indexOf("--body") + 1] ?? "";
    expect(hkBody).not.toContain("regenerates CODEOWNERS");
  });

  it("asks Claude for body-only markdown without YAML frontmatter", async () => {
    const tmp = useTmpDir();
    makeTreeShell(tmp.path);
    const fromSha = "aa".repeat(20);
    const toSha = "bb".repeat(20);
    writeTreeBinding(tmp.path, "source-prompt", {
      bindingMode: "standalone-source",
      entrypoint: "/repos/source",
      lastReconciledSourceCommit: fromSha,
      remoteUrl: "https://github.com/alice/source.git",
      rootKind: "git-repo",
      scope: "repo",
      sourceId: "source-prompt",
      sourceName: "source",
      sourceRootPath: "../source",
      treeMode: "dedicated",
      treeRepoName: "tree",
    });

    let claudePrompt = "";
    const shellRun: ShellRun = async (command, args) => {
      if (command === "gh" && args[0] === "auth") return okAuth();
      if (command === "claude" && args[0] === "--version") return claudeVersionOk();
      if (command === "gh" && args[0] === "api") {
        const path = args[1] ?? "";
        if (path === "/repos/alice/source/commits/HEAD") {
          return { stdout: `${toSha}\n`, stderr: "", code: 0 };
        }
        if (path.startsWith("/repos/alice/source/compare/")) {
          return {
            stdout: JSON.stringify({
              commits: [{
                sha: "1".repeat(40),
                commit: {
                  message: "feat(pkg-a): add docs",
                  author: { name: "alice", date: "2026-04-01T00:00:00Z" },
                },
                files: [{ filename: "pkg-a/x.ts" }],
              }],
            }),
            stderr: "",
            code: 0,
          };
        }
        if (path.startsWith("search/issues")) {
          return { stdout: JSON.stringify({ items: [] }), stderr: "", code: 0 };
        }
      }
      if (command === "claude" && args[0] === "-p") {
        claudePrompt = args.at(-1) ?? "";
        return {
          stdout: JSON.stringify([{
            path: "pkg-a",
            type: "TREE_OK",
            target_node_path: null,
            rationale: "Already documented",
            suggested_node_title: "",
            suggested_node_body_markdown: "",
          }]),
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", stderr: `no mock for ${command} ${args.join(" ")}`, code: 1 };
    };

    const code = await runSync(
      tmp.path,
      { source: undefined, propose: true, apply: false, dryRun: false },
      { shellRun },
    );

    expect(code).toBe(0);
    expect(claudePrompt).toContain("body content ONLY");
    expect(claudePrompt).toContain("Do NOT include YAML frontmatter");
  });

  it("strips Claude frontmatter and inherits parent owners plus PR author", async () => {
    const tmp = useTmpDir();
    makeTreeShell(tmp.path);
    mkdirSync(join(tmp.path, "engineering"), { recursive: true });
    writeFileSync(
      join(tmp.path, "engineering", "NODE.md"),
      "---\ntitle: Engineering\nowners: [core-team, review-lead]\n---\n# Engineering\n",
    );
    const fromSha = "cc".repeat(20);
    const toSha = "dd".repeat(20);
    writeTreeBinding(tmp.path, "source-owners", {
      bindingMode: "standalone-source",
      entrypoint: "/repos/source",
      lastReconciledSourceCommit: fromSha,
      remoteUrl: "https://github.com/alice/source.git",
      rootKind: "git-repo",
      scope: "repo",
      sourceId: "source-owners",
      sourceName: "source",
      sourceRootPath: "../source",
      treeMode: "dedicated",
      treeRepoName: "tree",
    });

    const shellRun: ShellRun = async (command, args) => {
      if (command === "gh" && args[0] === "auth") return okAuth();
      if (command === "claude" && args[0] === "--version") return claudeVersionOk();
      if (command === "gh" && args[0] === "api") {
        const path = args[1] ?? "";
        if (path === "/repos/alice/source/commits/HEAD") {
          return { stdout: `${toSha}\n`, stderr: "", code: 0 };
        }
        if (path.startsWith("/repos/alice/source/compare/")) {
          return {
            stdout: JSON.stringify({
              commits: [{
                sha: "1".repeat(40),
                commit: {
                  message: "feat(backend): add worker (#101)",
                  author: { name: "dev", date: "2026-04-01T00:00:00Z" },
                },
                files: [{ filename: "engineering/backend/worker.ts" }],
              }],
            }),
            stderr: "",
            code: 0,
          };
        }
        if (path.startsWith("search/issues")) {
          return {
            stdout: JSON.stringify({
              items: [{
                number: 101,
                title: "feat(backend): add worker",
                user: { login: "external-dev" },
                pull_request: {
                  merged_at: "2026-04-01T00:00:00Z",
                  merge_commit_sha: "1".repeat(40),
                },
              }],
            }),
            stderr: "",
            code: 0,
          };
        }
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]", stderr: "", code: 0 };
      }
      if (command === "claude" && args[0] === "-p") {
        return {
          stdout: JSON.stringify([{
            path: "engineering/backend",
            type: "TREE_MISS",
            target_node_path: null,
            rationale: "Backend worker is new knowledge",
            suggested_node_title: "backend",
            suggested_node_body_markdown: [
              "---",
              'title: "Backend"',
              "owners: [wrong-owner]",
              "soft_links: [/engineering]",
              "---",
              "",
              "# Backend",
              "",
              "New worker details.",
            ].join("\n"),
          }]),
          stderr: "",
          code: 0,
        };
      }
      if (command === "git") {
        if (args[0] === "symbolic-ref") {
          return { stdout: "main\n", stderr: "", code: 0 };
        }
        if (args.includes("diff") && args.includes("--cached") && args.includes("--quiet")) {
          return { stdout: "", stderr: "", code: 1 };
        }
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: `no mock for ${command} ${args.join(" ")}`, code: 1 };
    };

    const code = await runSync(
      tmp.path,
      { source: undefined, propose: false, apply: true, dryRun: true },
      { shellRun, verifyTree: () => 0 },
    );

    expect(code).toBe(0);
    const nodeText = readFileSync(join(tmp.path, "engineering", "backend", "NODE.md"), "utf-8");
    expect(nodeText).toContain("owners: [core-team, review-lead, external-dev]");
    expect(nodeText.match(/^---$/gm)?.length).toBe(2);
    expect(nodeText).not.toContain("soft_links: [/engineering]");
    expect(nodeText).toContain("# Backend");
  });

  it("reuses an existing member node when the PR author is already in members", async () => {
    const tmp = useTmpDir();
    makeTreeShell(tmp.path);
    mkdirSync(join(tmp.path, "members", "dotta"), { recursive: true });
    writeFileSync(
      join(tmp.path, "members", "NODE.md"),
      "---\ntitle: Members\nowners: []\n---\n# Members\n",
    );
    writeFileSync(
      join(tmp.path, "members", "dotta", "NODE.md"),
      [
        "---",
        'title: "Dotta"',
        "owners: [cryppadotta]",
        "github: cryppadotta",
        'type: "human"',
        'role: "Engineer"',
        "domains:",
        '  - "backend"',
        "---",
        "",
        "# Dotta",
      ].join("\n"),
    );
    const fromSha = "ee".repeat(20);
    const toSha = "ff".repeat(20);
    writeTreeBinding(tmp.path, "source-members", {
      bindingMode: "standalone-source",
      entrypoint: "/repos/source",
      lastReconciledSourceCommit: fromSha,
      remoteUrl: "https://github.com/alice/source.git",
      rootKind: "git-repo",
      scope: "repo",
      sourceId: "source-members",
      sourceName: "source",
      sourceRootPath: "../source",
      treeMode: "dedicated",
      treeRepoName: "tree",
    });

    const shellRun: ShellRun = async (command, args) => {
      if (command === "gh" && args[0] === "auth") return okAuth();
      if (command === "claude" && args[0] === "--version") return claudeVersionOk();
      if (command === "gh" && args[0] === "api") {
        const path = args[1] ?? "";
        if (path === "/repos/alice/source/commits/HEAD") {
          return { stdout: `${toSha}\n`, stderr: "", code: 0 };
        }
        if (path.startsWith("/repos/alice/source/compare/")) {
          return {
            stdout: JSON.stringify({
              commits: [{
                sha: "2".repeat(40),
                commit: {
                  message: "docs(member): update bio (#102)",
                  author: { name: "cryppadotta", date: "2026-04-02T00:00:00Z" },
                },
                files: [{ filename: "README.md" }],
              }],
            }),
            stderr: "",
            code: 0,
          };
        }
        if (path.startsWith("search/issues")) {
          return {
            stdout: JSON.stringify({
              items: [{
                number: 102,
                title: "docs(member): update bio",
                user: { login: "cryppadotta" },
                pull_request: {
                  merged_at: "2026-04-02T00:00:00Z",
                  merge_commit_sha: "2".repeat(40),
                },
              }],
            }),
            stderr: "",
            code: 0,
          };
        }
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]", stderr: "", code: 0 };
      }
      if (command === "claude" && args[0] === "-p") {
        return {
          stdout: JSON.stringify([{
            path: "members/cryppadotta",
            type: "TREE_MISS",
            target_node_path: null,
            rationale: "Member node missing",
            suggested_node_title: "cryppadotta",
            suggested_node_body_markdown: "# cryppadotta",
          }]),
          stderr: "",
          code: 0,
        };
      }
      if (command === "git") {
        if (args[0] === "symbolic-ref") {
          return { stdout: "main\n", stderr: "", code: 0 };
        }
        if (args.includes("diff") && args.includes("--cached") && args.includes("--quiet")) {
          return { stdout: "", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: `no mock for ${command} ${args.join(" ")}`, code: 1 };
    };

    const code = await runSync(
      tmp.path,
      { source: undefined, propose: false, apply: true, dryRun: true },
      { shellRun, verifyTree: () => 0 },
    );

    expect(code).toBe(0);
    expect(existsSync(join(tmp.path, "members", "cryppadotta", "NODE.md"))).toBe(false);
    expect(readFileSync(join(tmp.path, "members", "dotta", "NODE.md"), "utf-8")).toContain(
      "owners: [cryppadotta]",
    );
  });

  it("skips pushing PR branches that fail first-tree verify", async () => {
    const tmp = useTmpDir();
    makeTreeShell(tmp.path);
    const fromSha = "11".repeat(20);
    const toSha = "22".repeat(20);
    writeTreeBinding(tmp.path, "source-verify", {
      bindingMode: "standalone-source",
      entrypoint: "/repos/source",
      lastReconciledSourceCommit: fromSha,
      remoteUrl: "https://github.com/alice/source.git",
      rootKind: "git-repo",
      scope: "repo",
      sourceId: "source-verify",
      sourceName: "source",
      sourceRootPath: "../source",
      treeMode: "dedicated",
      treeRepoName: "tree",
    });

    const prCreateCalls: string[][] = [];
    const shellRun: ShellRun = async (command, args) => {
      if (command === "gh" && args[0] === "auth") return okAuth();
      if (command === "claude" && args[0] === "--version") return claudeVersionOk();
      if (command === "gh" && args[0] === "api") {
        const path = args[1] ?? "";
        if (path === "/repos/alice/source/commits/HEAD") {
          return { stdout: `${toSha}\n`, stderr: "", code: 0 };
        }
        if (path.startsWith("/repos/alice/source/compare/")) {
          return {
            stdout: JSON.stringify({
              commits: [{
                sha: "3".repeat(40),
                commit: {
                  message: "feat(pkg-a): add thing (#103)",
                  author: { name: "alice", date: "2026-04-03T00:00:00Z" },
                },
                files: [{ filename: "pkg-a/x.ts" }],
              }],
            }),
            stderr: "",
            code: 0,
          };
        }
        if (path.startsWith("search/issues")) {
          return {
            stdout: JSON.stringify({
              items: [{
                number: 103,
                title: "feat(pkg-a): add thing",
                user: { login: "alice" },
                pull_request: {
                  merged_at: "2026-04-03T00:00:00Z",
                  merge_commit_sha: "3".repeat(40),
                },
              }],
            }),
            stderr: "",
            code: 0,
          };
        }
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]", stderr: "", code: 0 };
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "create") {
        prCreateCalls.push([...args]);
        return { stdout: "https://github.com/x/y/pull/103", stderr: "", code: 0 };
      }
      if (command === "claude" && args[0] === "-p") {
        return {
          stdout: JSON.stringify([{
            path: "pkg-a",
            type: "TREE_MISS",
            target_node_path: null,
            rationale: "Need pkg-a node",
            suggested_node_title: "pkg-a",
            suggested_node_body_markdown: "# pkg-a",
          }]),
          stderr: "",
          code: 0,
        };
      }
      if (command === "git") {
        if (args[0] === "symbolic-ref") {
          return { stdout: "main\n", stderr: "", code: 0 };
        }
        if (args.includes("diff") && args.includes("--cached") && args.includes("--quiet")) {
          return { stdout: "", stderr: "", code: 1 };
        }
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: `no mock for ${command} ${args.join(" ")}`, code: 1 };
    };

    const code = await runSync(
      tmp.path,
      { source: undefined, propose: false, apply: true, dryRun: false },
      { shellRun, verifyTree: () => 1 },
    );

    expect(code).toBe(0);
    expect(prCreateCalls).toHaveLength(0);
  });
});

describe("sync CLI", () => {
  it("prints USAGE on --help", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runSyncCli(["--help"]);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(SYNC_USAGE);
    logSpy.mockRestore();
  });

  it("exits 1 when --tree-path target is not a tree repo", async () => {
    const tmp = useTmpDir();
    // No tree metadata whatsoever
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const shellRun: ShellRun = async (command, args) => {
      if (command === "gh" && args[0] === "auth") return okAuth();
      if (command === "claude" && args[0] === "--version") return claudeVersionOk();
      return { stdout: "", stderr: "", code: 1 };
    };
    const code = await runSyncCli(["--tree-path", tmp.path], { shellRun });
    expect(code).toBe(1);
    errSpy.mockRestore();
  });
});
