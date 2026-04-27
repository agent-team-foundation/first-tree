#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";

import { registerCommands } from "./commands/index.js";

type PackageJson = {
  version?: string;
};

const packageJsonUrl = new URL("../package.json", import.meta.url);

function readPackageVersion(): string {
  const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as PackageJson;

  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("Unable to read first-tree package version.");
  }

  return packageJson.version;
}

type CommandHelpEntry = {
  path: string;
  description: string;
};

function collectCommandHelpEntries(command: Command, parentPath: string[]): CommandHelpEntry[] {
  const entries: CommandHelpEntry[] = [];

  for (const childCommand of command.commands) {
    const commandPath = [...parentPath, childCommand.name()];

    entries.push({
      path: commandPath.join(" "),
      description: childCommand.description(),
    });
    entries.push(...collectCommandHelpEntries(childCommand, commandPath));
  }

  return entries;
}

function formatAllCommandsHelp(program: Command): string {
  const entries = collectCommandHelpEntries(program, [program.name()]);

  if (entries.length === 0) {
    return "";
  }

  const pathWidth = Math.max(...entries.map((entry) => entry.path.length));
  const lines = entries.map((entry) => {
    const description = entry.description.trim();

    if (description.length === 0) {
      return `  ${entry.path}`;
    }

    return `  ${entry.path.padEnd(pathWidth)}  ${description}`;
  });

  return `\nAll commands:\n${lines.join("\n")}\n`;
}

export function createProgram(version = readPackageVersion()): Command {
  const program = new Command();

  program
    .name("first-tree")
    .description("CLI for initializing and maintaining first-tree context trees.")
    .version(version);

  registerCommands(program);
  program.addHelpText("after", () => formatAllCommandsHelp(program));

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  await createProgram().parseAsync(argv);
}

function isDirectRun(): boolean {
  // A Node CLI bin invocation provides argv[1]; keep this guard for embedded runtimes.
  /* v8 ignore next 3 */
  if (process.argv[1] === undefined) {
    return false;
  }

  return import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href;
}

// Direct bin execution is covered by subprocess smoke tests.
/* v8 ignore next 6 */
if (isDirectRun()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Unexpected error: ${message}`);
    process.exitCode = 1;
  });
}
