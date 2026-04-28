import { describe, expect, it } from "vitest";
import { openTreePr } from "#products/tree/engine/open-tree-pr.js";
import type {
  ShellResult,
  ShellRun,
} from "#products/tree/engine/runtime/shell.js";

type Call = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
};

function recordingShell(
  handler: (c: Call) => ShellResult,
): { shell: ShellRun; calls: Call[] } {
  const calls: Call[] = [];
  const shell: ShellRun = async (command, args, options) => {
    const call = { command, args, env: options?.env };
    calls.push(call);
    return handler(call);
  };
  return { shell, calls };
}

describe("openTreePr", () => {
  it("pushes, creates PR, and applies labels on happy path", async () => {
    const { shell, calls } = recordingShell((c) => {
      if (c.command === "git" && c.args[0] === "push") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (c.command === "gh" && c.args[0] === "pr" && c.args[1] === "create") {
        return { stdout: "https://github.com/o/r/pull/42\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const result = await openTreePr(shell, "/tree", {
      branch: "first-tree/sync-abc",
      title: "sync: abc",
      body: "body",
      labels: ["first-tree:sync"],
    });

    expect(result).toEqual({ success: true, prUrl: "https://github.com/o/r/pull/42" });

    const kinds = calls.map((c) => `${c.command} ${c.args.slice(0, 2).join(" ")}`);
    // Auto-merge is opt-in (defaults to false). The happy path should
    // NOT include `gh pr merge` — that only fires when the caller
    // passes `autoMerge: true`. See OpenTreePrOpts.autoMerge.
    expect(kinds).toEqual([
      "git push origin",
      "gh pr create",
      "gh label create",
      "gh pr edit",
    ]);

    const prCreate = calls.find((c) => c.command === "gh" && c.args[1] === "create")!;
    expect(prCreate.args).toEqual([
      "pr", "create",
      "--head", "first-tree/sync-abc",
      "--title", "sync: abc",
      "--body", "body",
    ]);

    const labelCreate = calls.find((c) => c.command === "gh" && c.args[0] === "label")!;
    expect(labelCreate.args).toEqual([
      "label", "create", "first-tree:sync",
      "--color", "2ea44f",
      "--description", "Created by gardener sync",
      "--force",
    ]);

    const prEdit = calls.find((c) => c.command === "gh" && c.args[1] === "edit")!;
    expect(prEdit.args).toEqual([
      "pr", "edit", "https://github.com/o/r/pull/42",
      "--add-label", "first-tree:sync",
    ]);
  });

  it("returns failure when git push fails", async () => {
    const { shell, calls } = recordingShell((c) => {
      if (c.command === "git" && c.args[0] === "push") {
        return { stdout: "", stderr: "remote rejected\n", code: 1 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const result = await openTreePr(shell, "/tree", {
      branch: "b", title: "t", body: "y", labels: ["first-tree:sync"],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("git push failed");
    expect(result.error).toContain("remote rejected");
    expect(calls).toHaveLength(1);
  });

  it("treats 'already exists' as success and skips labels", async () => {
    const { shell, calls } = recordingShell((c) => {
      if (c.command === "git") return { stdout: "", stderr: "", code: 0 };
      if (c.args[1] === "create") {
        return { stdout: "", stderr: "a pull request for branch already exists", code: 1 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const result = await openTreePr(shell, "/tree", {
      branch: "b", title: "t", body: "y", labels: ["first-tree:sync"],
    });

    expect(result.success).toBe(true);
    expect(result.prUrl).toBe("(existing PR for b)");
    expect(calls.some((c) => c.command === "gh" && c.args[0] === "label")).toBe(false);
    expect(calls.some((c) => c.command === "gh" && c.args[1] === "edit")).toBe(false);
  });

  it("skips label calls entirely when labels is omitted or empty", async () => {
    const { shell, calls } = recordingShell((c) => {
      if (c.command === "git") return { stdout: "", stderr: "", code: 0 };
      if (c.args[1] === "create") return { stdout: "https://x/pr/1", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    });

    const result = await openTreePr(shell, "/tree", {
      branch: "b", title: "t", body: "y",
    });

    expect(result).toEqual({ success: true, prUrl: "https://x/pr/1" });
    // No labels and no autoMerge → only push + create.
    expect(calls.map((c) => c.command + " " + c.args[0] + " " + c.args[1])).toEqual([
      "git push origin",
      "gh pr create",
    ]);
  });

  it("supports multiple custom labels", async () => {
    const { shell, calls } = recordingShell((c) => {
      if (c.command === "git") return { stdout: "", stderr: "", code: 0 };
      if (c.args[1] === "create") return { stdout: "https://x/pr/1", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    });

    await openTreePr(shell, "/tree", {
      branch: "b", title: "t", body: "y",
      labels: ["label-a", "label-b"],
    });

    const labelCreates = calls.filter((c) => c.command === "gh" && c.args[0] === "label");
    expect(labelCreates.map((c) => c.args[2])).toEqual(["label-a", "label-b"]);

    const prEdit = calls.find((c) => c.command === "gh" && c.args[1] === "edit")!;
    expect(prEdit.args).toEqual([
      "pr", "edit", "https://x/pr/1",
      "--add-label", "label-a",
      "--add-label", "label-b",
    ]);
  });

  it("passes env through to gh calls only", async () => {
    const { shell, calls } = recordingShell((c) => {
      if (c.command === "git") return { stdout: "", stderr: "", code: 0 };
      if (c.args[1] === "create") return { stdout: "https://x/pr/1", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    });

    await openTreePr(shell, "/tree", {
      branch: "b",
      title: "t",
      body: "y",
      labels: ["label-a"],
      env: { GH_TOKEN: "secret-token" },
    });

    const gitPush = calls.find((c) => c.command === "git")!;
    expect(gitPush.env).toBe(undefined);

    const ghCalls = calls.filter((c) => c.command === "gh");
    // pr create + label create + pr edit (no auto-merge by default)
    expect(ghCalls).toHaveLength(3);
    for (const call of ghCalls) {
      expect(call.env?.GH_TOKEN).toBe("secret-token");
    }
  });

  it("does NOT queue auto-merge by default", async () => {
    // Auto-merge is opt-in. Default off avoids silently merging fresh
    // sync PRs on tree repos without branch protection.
    const { shell, calls } = recordingShell((c) => {
      if (c.command === "git") return { stdout: "", stderr: "", code: 0 };
      if (c.args[1] === "create") return { stdout: "https://x/pr/7", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    });

    await openTreePr(shell, "/tree", { branch: "b", title: "t", body: "y" });

    expect(calls.some((c) => c.command === "gh" && c.args[1] === "merge")).toBe(false);
  });

  it("queues GitHub native auto-merge when autoMerge=true (#321)", async () => {
    const { shell, calls } = recordingShell((c) => {
      if (c.command === "git") return { stdout: "", stderr: "", code: 0 };
      if (c.args[1] === "create") return { stdout: "https://x/pr/7", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    });

    await openTreePr(shell, "/tree", { branch: "b", title: "t", body: "y", autoMerge: true });

    const autoMerge = calls.find((c) => c.command === "gh" && c.args[1] === "merge")!;
    expect(autoMerge.args).toEqual([
      "pr", "merge", "https://x/pr/7",
      "--auto", "--squash", "--delete-branch",
    ]);
  });

  it("skips auto-merge queueing when the PR already exists (even with autoMerge=true)", async () => {
    const { shell, calls } = recordingShell((c) => {
      if (c.command === "git") return { stdout: "", stderr: "", code: 0 };
      if (c.args[1] === "create") {
        return { stdout: "", stderr: "a pull request for branch already exists", code: 1 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const result = await openTreePr(shell, "/tree", { branch: "b", title: "t", body: "y", autoMerge: true });

    expect(result.success).toBe(true);
    expect(calls.some((c) => c.command === "gh" && c.args[1] === "merge")).toBe(false);
  });

  it("treats the 'auto-merge not allowed' error as success when autoMerge=true (repo hasn't opted in)", async () => {
    const { shell, calls } = recordingShell((c) => {
      if (c.command === "git") return { stdout: "", stderr: "", code: 0 };
      if (c.args[1] === "create") return { stdout: "https://x/pr/9", stderr: "", code: 0 };
      if (c.args[1] === "merge") {
        return { stdout: "", stderr: "auto-merge is not allowed for this repository", code: 1 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const result = await openTreePr(shell, "/tree", { branch: "b", title: "t", body: "y", autoMerge: true });

    expect(result).toEqual({ success: true, prUrl: "https://x/pr/9" });
    expect(calls.some((c) => c.command === "gh" && c.args[1] === "merge")).toBe(true);
  });

  it("surfaces non-disabled gh pr merge failures when autoMerge=true", async () => {
    const { shell } = recordingShell((c) => {
      if (c.command === "git") return { stdout: "", stderr: "", code: 0 };
      if (c.args[1] === "create") return { stdout: "https://x/pr/11", stderr: "", code: 0 };
      if (c.args[1] === "merge") {
        return { stdout: "", stderr: "HTTP 401: Bad credentials", code: 1 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const result = await openTreePr(shell, "/tree", { branch: "b", title: "t", body: "y", autoMerge: true });

    expect(result.success).toBe(false);
    expect(result.prUrl).toBe("https://x/pr/11");
    expect(result.error).toContain("gh pr merge --auto failed");
    expect(result.error).toContain("Bad credentials");
  });
});
