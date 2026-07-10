import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export type NpmInvocation = {
  command: string;
  args: string[];
  shell: boolean;
};

type ResolveNpmInvocationOptions = {
  platform?: NodeJS.Platform;
  execPath?: string;
  pathExists?: (path: string) => boolean;
};

/**
 * Resolve npm without asking Windows to execute a `.cmd` shim directly.
 *
 * `child_process.spawn(".../npm.cmd", args)` synchronously throws EINVAL on
 * Windows. Using that absolute path with `shell: true` is not sufficient
 * either: cmd.exe truncates an unquoted `C:\Program Files\...` command at the
 * first space. Standard Node installations ship npm's JavaScript entry point
 * beside the launching Node, so invoke that entry point with the current
 * `node.exe`. The PATH fallback keeps custom layouts working through cmd.exe
 * without embedding an absolute path that needs shell quoting.
 */
export function resolveNpmInvocation(
  npmArgs: readonly string[],
  options: ResolveNpmInvocationOptions = {},
): NpmInvocation {
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  const pathExists = options.pathExists ?? existsSync;
  const nodeDir = dirname(execPath);

  if (platform === "win32") {
    const npmCli = join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
    if (pathExists(npmCli)) {
      return { command: execPath, args: [npmCli, ...npmArgs], shell: false };
    }
    return { command: "npm", args: [...npmArgs], shell: true };
  }

  const sibling = join(nodeDir, "npm");
  return {
    command: pathExists(sibling) ? sibling : "npm",
    args: [...npmArgs],
    shell: false,
  };
}
