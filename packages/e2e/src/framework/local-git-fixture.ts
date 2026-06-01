import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/**
 * Minimal local git repo fixture for onboarding-style e2e tests that need a
 * "fresh source repo" to point the CLI at, without cloning anything off the
 * network.
 *
 * Layout (`mkdtempSync` mints the parent so concurrent describes never collide):
 *
 *   $TMPDIR/first-tree-e2e-fixture-XXXX/source/        ← initialized git repo
 *
 * `first-tree tree init` creates its sibling tree dir under the same minted
 * parent (`.../source-tree`), so `cleanup()` rms the whole parent and clears
 * both repos in one shot.
 */

export type LocalGitFixture = {
  /** Absolute path to the initialized source repo (a real git checkout). */
  repoRoot: string;
  /** Recursively rm the minted parent dir — i.e. both `source/` and any tree
   * dir the CLI placed alongside it. Safe to call multiple times. */
  cleanup: () => void;
};

export function makeLocalGitFixture(): LocalGitFixture {
  const parentDir = mkdtempSync(resolve(tmpdir(), "first-tree-e2e-fixture-"));
  const repoRoot = resolve(parentDir, "source");

  mkdirSync(repoRoot, { recursive: true });
  writeFileSync(
    resolve(repoRoot, "README.md"),
    "# onboarding-direct fixture\n\nLocal fixture for e2e — created by makeLocalGitFixture.\n",
  );

  // -b main pins the default branch so the test is independent of the
  // executor's `init.defaultBranch` config. Identity is set inline because
  // CI runners may not have a global user.email/name configured.
  const git = (args: string[]): void => {
    execFileSync("git", args, {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "first-tree e2e",
        GIT_AUTHOR_EMAIL: "e2e@first-tree.invalid",
        GIT_COMMITTER_NAME: "first-tree e2e",
        GIT_COMMITTER_EMAIL: "e2e@first-tree.invalid",
      },
    });
  };
  git(["init", "-q", "-b", "main"]);
  git(["add", "README.md"]);
  git(["commit", "-q", "-m", "chore: initial fixture"]);

  return {
    repoRoot,
    cleanup: () => {
      rmSync(parentDir, { recursive: true, force: true });
    },
  };
}
