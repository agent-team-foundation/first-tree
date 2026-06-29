import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { CommandResult } from "./types.js";

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
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
