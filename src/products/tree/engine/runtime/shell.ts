/**
 * Shared shell-runner types for the tree product's engine primitives.
 *
 * Kept separate from any concrete runner so primitives (`sync.ts`,
 * `open-tree-pr.ts`, future extractions) can depend on the shape
 * without creating circular imports.
 *
 * `env?: NodeJS.ProcessEnv` is an optional passthrough; tree's runner
 * never sets it, but gardener's sync `--open-issues` mode needs to
 * thread `GH_TOKEN=TREE_REPO_TOKEN` into `gh issue create`.
 */

export interface ShellResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type ShellRun = (
  command: string,
  args: string[],
  options?: { cwd?: string; input?: string; timeout?: number; env?: NodeJS.ProcessEnv },
) => Promise<ShellResult>;
