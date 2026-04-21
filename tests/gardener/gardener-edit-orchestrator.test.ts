import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { orchestrateEdit } from "#products/gardener/engine/edit-orchestrator.js";
import type { PrView, ShellResult, ShellRun } from "#products/gardener/engine/respond.js";
import { useTmpDir } from "../helpers.js";

interface ShellCall {
  command: string;
  args: string[];
  cwd?: string;
}

function makeShell(
  handler: (call: ShellCall) => ShellResult,
  calls: ShellCall[] = [],
): ShellRun {
  return async (command, args, options) => {
    const call: ShellCall = { command, args, cwd: options?.cwd };
    calls.push(call);
    return handler(call);
  };
}

const DEFAULT_PR_VIEW: PrView = {
  number: 42,
  headRefName: "first-tree/sync-foo",
};

function seedParent(dir: string, relPath: string, body: string): string {
  const full = join(dir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
  return full;
}

describe("edit-orchestrator: parent_subdomain_missing heuristic", () => {
  it("appends the missing child under ## Sub-domains and pushes", async () => {
    const tree = useTmpDir().path;
    seedParent(
      tree,
      "NODE.md",
      "# Root\n\n## Sub-domains\n\n- `alpha/` — Alpha\n",
    );

    const calls: ShellCall[] = [];
    const shell = makeShell((call) => {
      if (call.command === "git" && call.args[0] === "rev-parse") {
        return { stdout: "deadbeef1234567\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    }, calls);

    const result = await orchestrateEdit({
      repo: "acme/tree",
      pr: 42,
      treeRoot: tree,
      feedback: {
        reviews: [
          {
            state: "CHANGES_REQUESTED",
            body: "beta/NODE.md is not listed in parent NODE.md. title: Beta",
          },
        ],
        issueComments: [],
      },
      prView: DEFAULT_PR_VIEW,
      shell,
      dryRun: false,
    });

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") throw new Error("unreachable");
    expect(result.pattern).toBe("parent_subdomain_missing");
    expect(result.sha).toBe("deadbeef1234567");

    const updated = readFileSync(join(tree, "NODE.md"), "utf-8");
    expect(updated).toContain("- `beta/` — Beta");
    expect(updated).toContain("- `alpha/` — Alpha");

    const gitCmds = calls.filter((c) => c.command === "git").map((c) => c.args[0]);
    expect(gitCmds).toEqual(["add", "commit", "push", "rev-parse"]);
    const pushCall = calls.find((c) => c.command === "git" && c.args[0] === "push");
    expect(pushCall?.args).toEqual(["push", "origin", "HEAD"]);
    // Never force-push.
    expect(pushCall?.args).not.toContain("--force");
    expect(pushCall?.args).not.toContain("--force-with-lease");
  });

  it("is idempotent when the child is already listed", async () => {
    const tree = useTmpDir().path;
    seedParent(
      tree,
      "NODE.md",
      "# Root\n\n## Sub-domains\n\n- `beta/` — Beta\n",
    );

    const result = await orchestrateEdit({
      repo: "acme/tree",
      pr: 42,
      treeRoot: tree,
      feedback: {
        reviews: [
          {
            state: "CHANGES_REQUESTED",
            body: "beta/NODE.md is not listed in parent NODE.md",
          },
        ],
        issueComments: [],
      },
      prView: DEFAULT_PR_VIEW,
      shell: makeShell(() => ({ stdout: "", stderr: "", code: 0 })),
      dryRun: false,
    });

    expect(result.kind).toBe("deferred");
  });

  it("returns deferred rebase_needed on non-fast-forward push", async () => {
    const tree = useTmpDir().path;
    seedParent(tree, "NODE.md", "# Root\n\n## Sub-domains\n\n");

    const shell = makeShell((call) => {
      if (call.command === "git" && call.args[0] === "push") {
        return {
          stdout: "",
          stderr: "! [rejected] HEAD -> main (non-fast-forward)",
          code: 1,
        };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const result = await orchestrateEdit({
      repo: "acme/tree",
      pr: 42,
      treeRoot: tree,
      feedback: {
        reviews: [
          {
            state: "CHANGES_REQUESTED",
            body: "gamma/NODE.md is not listed in parent NODE.md. title: Gamma",
          },
        ],
        issueComments: [],
      },
      prView: DEFAULT_PR_VIEW,
      shell,
      dryRun: false,
    });

    expect(result.kind).toBe("deferred");
    if (result.kind !== "deferred") throw new Error("unreachable");
    expect(result.reason).toBe("rebase_needed");
  });

  it("returns deferred unsupported_pattern when heuristic doesn't match and no planner", async () => {
    const tree = useTmpDir().path;
    const result = await orchestrateEdit({
      repo: "acme/tree",
      pr: 42,
      treeRoot: tree,
      feedback: {
        reviews: [
          {
            state: "CHANGES_REQUESTED",
            body: "please rewrite the whole section",
          },
        ],
        issueComments: [],
      },
      prView: DEFAULT_PR_VIEW,
      shell: makeShell(() => ({ stdout: "", stderr: "", code: 0 })),
      dryRun: false,
    });

    expect(result.kind).toBe("deferred");
    if (result.kind !== "deferred") throw new Error("unreachable");
    expect(result.reason).toBe("unsupported_pattern");
  });

  it("dry-run returns applied without touching the filesystem or shell", async () => {
    const tree = useTmpDir().path;
    const parentPath = seedParent(
      tree,
      "NODE.md",
      "# Root\n\n## Sub-domains\n\n",
    );
    const before = readFileSync(parentPath, "utf-8");

    const calls: ShellCall[] = [];
    const shell = makeShell(
      () => ({ stdout: "", stderr: "", code: 0 }),
      calls,
    );

    const result = await orchestrateEdit({
      repo: "acme/tree",
      pr: 42,
      treeRoot: tree,
      feedback: {
        reviews: [
          {
            state: "CHANGES_REQUESTED",
            body: "delta/NODE.md is not listed in parent NODE.md. title: Delta",
          },
        ],
        issueComments: [],
      },
      prView: DEFAULT_PR_VIEW,
      shell,
      dryRun: true,
    });

    expect(result.kind).toBe("applied");
    expect(calls).toHaveLength(0);
    expect(readFileSync(parentPath, "utf-8")).toBe(before);
  });

  it("invokes the injected planner when the heuristic does not match", async () => {
    const tree = useTmpDir().path;
    seedParent(tree, "NOTES.md", "old content\n");

    const calls: ShellCall[] = [];
    const shell = makeShell((call) => {
      if (call.command === "git" && call.args[0] === "rev-parse") {
        return { stdout: "planner-sha\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    }, calls);

    const result = await orchestrateEdit({
      repo: "acme/tree",
      pr: 42,
      treeRoot: tree,
      feedback: {
        reviews: [{ state: "CHANGES_REQUESTED", body: "do something custom" }],
        issueComments: [],
      },
      prView: DEFAULT_PR_VIEW,
      shell,
      dryRun: false,
      planner: async () => ({
        pattern: "custom_pattern",
        summary: "rewrite notes",
        replyBody: "Done.",
        files: [
          {
            path: join(tree, "NOTES.md"),
            before: "old content\n",
            after: "new content\n",
          },
        ],
      }),
    });

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") throw new Error("unreachable");
    expect(result.pattern).toBe("custom_pattern");
    expect(readFileSync(join(tree, "NOTES.md"), "utf-8")).toBe("new content\n");
  });

  it("returns deferred stale_base when file on disk diverges from plan.before", async () => {
    const tree = useTmpDir().path;
    const parentPath = seedParent(tree, "NOTES.md", "actual disk content\n");

    const result = await orchestrateEdit({
      repo: "acme/tree",
      pr: 42,
      treeRoot: tree,
      feedback: {
        reviews: [{ state: "CHANGES_REQUESTED", body: "custom" }],
        issueComments: [],
      },
      prView: DEFAULT_PR_VIEW,
      shell: makeShell(() => ({ stdout: "", stderr: "", code: 0 })),
      dryRun: false,
      planner: () => ({
        pattern: "custom",
        summary: "s",
        replyBody: "r",
        files: [
          { path: parentPath, before: "stale\n", after: "new\n" },
        ],
      }),
    });

    expect(result.kind).toBe("deferred");
    if (result.kind !== "deferred") throw new Error("unreachable");
    expect(result.reason).toBe("stale_base");
  });

  it("resolves nested child to the correct parent (not tree root) — #229 review", async () => {
    const tree = useTmpDir().path;
    // engineering/NODE.md is the correct parent for engineering/mcp/
    seedParent(
      tree,
      "engineering/NODE.md",
      "# Engineering\n\n## Sub-domains\n\n",
    );
    // A tree-root NODE.md also exists — we should NOT write to it.
    seedParent(tree, "NODE.md", "# Root\n\n## Sub-domains\n\n- `alpha/` — Alpha\n");

    const shell = makeShell((call) => {
      if (call.command === "git" && call.args[0] === "rev-parse") {
        return { stdout: "nestedsha\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const result = await orchestrateEdit({
      repo: "acme/tree",
      pr: 42,
      treeRoot: tree,
      feedback: {
        reviews: [
          {
            state: "CHANGES_REQUESTED",
            body: "engineering/mcp/NODE.md is not listed in parent NODE.md. title: MCP",
          },
        ],
        issueComments: [],
      },
      prView: DEFAULT_PR_VIEW,
      shell,
      dryRun: false,
    });

    expect(result.kind).toBe("applied");

    const engParent = readFileSync(join(tree, "engineering/NODE.md"), "utf-8");
    expect(engParent).toContain("- `mcp/` — MCP");

    // Root NODE.md should be untouched — no `mcp/` entry written to it.
    const rootParent = readFileSync(join(tree, "NODE.md"), "utf-8");
    expect(rootParent).not.toContain("mcp/");
  });

  it("rejects path-traversal parent hint — #229 review", async () => {
    const tree = useTmpDir().path;
    seedParent(tree, "NODE.md", "# Root\n\n## Sub-domains\n\n");

    const shell = makeShell(() => ({ stdout: "", stderr: "", code: 0 }));

    const result = await orchestrateEdit({
      repo: "acme/tree",
      pr: 42,
      treeRoot: tree,
      feedback: {
        reviews: [
          {
            state: "CHANGES_REQUESTED",
            body:
              "parent: ../../../../tmp/pwn/NODE.md — child/NODE.md is not listed in parent NODE.md. title: Child",
          },
        ],
        issueComments: [],
      },
      prView: DEFAULT_PR_VIEW,
      shell,
      dryRun: false,
    });

    expect(result.kind).toBe("deferred");
  });

  it("rejects absolute parent hint — #229 review", async () => {
    const tree = useTmpDir().path;
    seedParent(tree, "NODE.md", "# Root\n\n## Sub-domains\n\n");

    const result = await orchestrateEdit({
      repo: "acme/tree",
      pr: 42,
      treeRoot: tree,
      feedback: {
        reviews: [
          {
            state: "CHANGES_REQUESTED",
            body:
              "parent: /etc/NODE.md — child/NODE.md is not listed in parent NODE.md",
          },
        ],
        issueComments: [],
      },
      prView: DEFAULT_PR_VIEW,
      shell: makeShell(() => ({ stdout: "", stderr: "", code: 0 })),
      dryRun: false,
    });

    expect(result.kind).toBe("deferred");
  });

  it("rejects parent hint not targeting NODE.md — #229 review", async () => {
    const tree = useTmpDir().path;
    seedParent(tree, "NODE.md", "# Root\n\n## Sub-domains\n\n");

    const result = await orchestrateEdit({
      repo: "acme/tree",
      pr: 42,
      treeRoot: tree,
      feedback: {
        reviews: [
          {
            state: "CHANGES_REQUESTED",
            body:
              "parent: README.md — child/NODE.md is not listed in parent NODE.md",
          },
        ],
        issueComments: [],
      },
      prView: DEFAULT_PR_VIEW,
      shell: makeShell(() => ({ stdout: "", stderr: "", code: 0 })),
      dryRun: false,
    });

    expect(result.kind).toBe("deferred");
  });

  it("returns failed when the planner throws", async () => {
    const tree = useTmpDir().path;
    const result = await orchestrateEdit({
      repo: "acme/tree",
      pr: 42,
      treeRoot: tree,
      feedback: {
        reviews: [{ state: "CHANGES_REQUESTED", body: "custom" }],
        issueComments: [],
      },
      prView: DEFAULT_PR_VIEW,
      shell: makeShell(() => ({ stdout: "", stderr: "", code: 0 })),
      dryRun: false,
      planner: () => {
        throw new Error("planner boom");
      },
    });

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("unreachable");
    expect(result.reason).toContain("planner boom");
  });
});
