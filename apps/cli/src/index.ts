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

export function createProgram(version = readPackageVersion()): Command {
  const program = new Command();

  program
    .name("first-tree")
    .description("CLI for initializing and maintaining first-tree context trees.")
    .version(version);

  registerCommands(program);

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  await createProgram().parseAsync(argv);
}

function isDirectRun(): boolean {
  if (process.argv[1] === undefined) {
    return false;
  }

  return import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href;
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Unexpected error: ${message}`);
    process.exitCode = 1;
  });
}
