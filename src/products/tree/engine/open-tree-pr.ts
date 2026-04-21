import type { ShellRun } from "#products/tree/engine/runtime/shell.js";

export interface OpenTreePrOpts {
  branch: string;
  title: string;
  body: string;
  labels?: string[];
}

export interface OpenTreePrResult {
  success: boolean;
  prUrl?: string;
  error?: string;
}

/**
 * Push a branch to origin and open a tree PR against the default base.
 *
 * Shared by `sync` (per-content and housekeeping PRs) and `respond`
 * (rescued-from-merged-source flow). The shell-call envelope produced
 * here is parsed by repo-gardener — see
 * `tests/fixtures/sync-golden/README.md`. Changing the sequence or
 * argv shape of git/gh invocations is a coordinated change.
 */
export async function openTreePr(
  shellRun: ShellRun,
  treeRoot: string,
  opts: OpenTreePrOpts,
): Promise<OpenTreePrResult> {
  const { branch, title, body, labels } = opts;

  const pushResult = await shellRun("git", ["push", "origin", branch], {
    cwd: treeRoot,
  });
  if (pushResult.code !== 0) {
    return { success: false, error: `git push failed: ${pushResult.stderr.trim()}` };
  }

  const prCreate = await shellRun(
    "gh",
    ["pr", "create", "--head", branch, "--title", title, "--body", body],
    { cwd: treeRoot },
  );
  if (prCreate.code !== 0) {
    const stderr = prCreate.stderr.trim();
    if (
      stderr.toLowerCase().includes("already exists")
      || stderr.toLowerCase().includes("a pull request for branch")
    ) {
      return { success: true, prUrl: `(existing PR for ${branch})` };
    }
    return { success: false, error: `gh pr create failed: ${stderr}` };
  }
  const prUrl = prCreate.stdout.trim();

  if (labels && labels.length > 0) {
    for (const label of labels) {
      await shellRun(
        "gh",
        ["label", "create", label, "--color", "2ea44f", "--description", `Created by first-tree sync`, "--force"],
        { cwd: treeRoot },
      );
    }
    const labelArgs = labels.flatMap((l) => ["--add-label", l]);
    await shellRun("gh", ["pr", "edit", prUrl, ...labelArgs], { cwd: treeRoot });
  }

  return { success: true, prUrl };
}
