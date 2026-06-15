import { spawnSync } from "node:child_process";

import type { CommandResult } from "./types.js";

export const TREE_TREE_ARGV = ["tree", "tree"] as const;
export const TREE_TREE_HELP_ARGV = ["tree", "tree", "--help"] as const;

export function argvEquals(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function argvStartsWith(argv: readonly string[], prefix: readonly string[]): boolean {
  if (argv.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (argv[index] !== prefix[index]) return false;
  }
  return true;
}

export function isTreeTreeHelpArgv(argv: readonly string[]): boolean {
  return argvEquals(argv, TREE_TREE_HELP_ARGV);
}

export function isTreeTreeArgv(argv: readonly string[]): boolean {
  return argvStartsWith(argv, TREE_TREE_ARGV);
}

export function isTreeTreeSelectorArgv(argv: readonly string[]): boolean {
  return isTreeTreeArgv(argv) && !isTreeTreeHelpArgv(argv);
}

export function isTreeVerifyArgv(argv: readonly string[]): boolean {
  return argv[0] === "tree" && argv[1] === "verify";
}

export function formatArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/u.test(arg)) return arg;
  return JSON.stringify(arg);
}

export function formatCommand(argv: readonly string[]): string {
  return argv.map(formatArg).join(" ");
}

export function runCommand(command: string, args: readonly string[], cwd: string): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  return {
    args,
    command,
    cwd,
    exitCode: result.status ?? 1,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

export function assertCommandOk(result: CommandResult): void {
  if (result.exitCode === 0) return;
  throw new Error(
    `${result.command} ${result.args.join(" ")} failed with exit ${result.exitCode}\n${result.stderr}${result.stdout}`,
  );
}
