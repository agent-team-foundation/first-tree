import type { ShellRun } from "#products/tree/engine/runtime/shell.js";

export interface OpenTreePrOpts {
  branch: string;
  title: string;
  body: string;
  labels?: string[];
  env?: NodeJS.ProcessEnv;
  /**
   * Queue GitHub's native auto-merge after the PR is opened. Defaults
   * to **false**.
   *
   * `gh pr merge --auto` waits for branch protection (required reviews,
   * required checks) to be satisfied before merging. On a repo without
   * branch protection, "auto-merge" merges immediately — the PR opens
   * and lands in the same instant, bypassing review entirely. Several
   * deployments have seen tree PRs merged without a single approval
   * because of this.
   *
   * Default off so the unsafe path is opt-in. Callers (gardener-sync)
   * should only set `autoMerge: true` when the tree repo has branch
   * protection that requires approvals — typically driven by a config
   * flag like `modules.sync.auto_merge: true` in
   * `.claude/gardener-config.yaml`.
   */
  autoMerge?: boolean;
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
  const { branch, title, body, labels, env, autoMerge = false } = opts;

  const pushResult = await shellRun("git", ["push", "origin", branch], {
    cwd: treeRoot,
  });
  if (pushResult.code !== 0) {
    return { success: false, error: `git push failed: ${pushResult.stderr.trim()}` };
  }

  const prCreate = await shellRun(
    "gh",
    ["pr", "create", "--head", branch, "--title", title, "--body", body],
    { cwd: treeRoot, env },
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
        ["label", "create", label, "--color", "2ea44f", "--description", `Created by gardener sync`, "--force"],
        { cwd: treeRoot, env },
      );
    }
    const labelArgs = labels.flatMap((l) => ["--add-label", l]);
    await shellRun("gh", ["pr", "edit", prUrl, ...labelArgs], { cwd: treeRoot, env });
  }

  // Queue GitHub's native auto-merge — but only when the caller
  // explicitly opts in. `gh pr merge --auto` is safe ONLY on repos with
  // branch protection that requires approvals/checks; on a repo without
  // protection it merges immediately and bypasses review. Default off
  // means a fresh deployment never silently auto-merges sync PRs. See
  // #321 for context.
  if (autoMerge) {
    const autoMergeResult = await shellRun(
      "gh",
      ["pr", "merge", prUrl, "--auto", "--squash", "--delete-branch"],
      { cwd: treeRoot, env },
    );
    if (autoMergeResult.code !== 0 && !isAutoMergeDisabledError(autoMergeResult.stderr)) {
      return {
        success: false,
        prUrl,
        error: `gh pr merge --auto failed: ${autoMergeResult.stderr.trim()}`,
      };
    }
  }

  return { success: true, prUrl };
}

/**
 * Recognize the specific gh error surface for "this repo has not
 * enabled auto-merge." Anything else is a real failure.
 *
 * gh/GitHub have used a handful of phrasings across versions. We match
 * on the narrow set known to indicate disabled-on-repo, not on any
 * stderr mentioning "auto-merge" — an auth failure message could also
 * contain the word.
 */
function isAutoMergeDisabledError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return (
    lower.includes("auto-merge is not allowed")
    || lower.includes("auto merge is not allowed")
    || lower.includes("does not allow auto-merge")
    || lower.includes("pull request auto merge is not allowed")
    || lower.includes("auto-merge is not enabled")
  );
}
