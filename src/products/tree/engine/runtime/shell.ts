/**
 * Shared shell-runner types for the tree product's engine primitives.
 *
 * Kept separate from any concrete runner so primitives (`sync.ts`,
 * `open-tree-pr.ts`, future extractions) can depend on the shape
 * without creating circular imports.
 *
 * Gardener has its own locally-defined `ShellRun` / `ShellResult` that
 * carries an `env?: NodeJS.ProcessEnv` option tree's runner doesn't
 * need — intentionally not unified here.
 */

export interface ShellResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type ShellRun = (
  command: string,
  args: string[],
  options?: { cwd?: string; input?: string; timeout?: number },
) => Promise<ShellResult>;
