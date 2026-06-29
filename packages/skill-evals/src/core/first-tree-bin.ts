import { existsSync } from "node:fs";
import { basename, delimiter, isAbsolute, join } from "node:path";

import type { RunPaths } from "./types.js";

const FIRST_TREE_BIN_ENV_VARS = ["FIRST_TREE_EVAL_FIRST_TREE_BIN", "FT_BIN"] as const;
const FIRST_TREE_BIN_NAMES = ["first-tree-staging", "first-tree-dev", "first-tree"] as const;

export function resolveFirstTreeBin(paths: RunPaths, env: NodeJS.ProcessEnv = process.env): string {
  for (const key of FIRST_TREE_BIN_ENV_VARS) {
    const value = env[key]?.trim();
    if (value) return value;
  }

  for (const name of FIRST_TREE_BIN_NAMES) {
    const localShim = join(paths.binDir, name);
    if (existsSync(localShim)) return localShim;
  }

  for (const name of FIRST_TREE_BIN_NAMES) {
    if (canResolveExecutable(name, env.PATH)) return name;
  }

  return "first-tree";
}

export function firstTreeCommandLabel(command: string): string {
  return isAbsolute(command) ? basename(command) : command;
}

function canResolveExecutable(command: string, pathValue: string | undefined): boolean {
  if (isAbsolute(command)) return existsSync(command);
  if (!pathValue) return false;

  return pathValue.split(delimiter).some((dir) => dir.length > 0 && existsSync(join(dir, command)));
}
