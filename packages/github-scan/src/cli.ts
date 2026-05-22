#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { runGitHubScan } from "./github-scan/cli.js";

export async function runCli(args: string[] = process.argv.slice(2)): Promise<number> {
  return runGitHubScan(args, (text) => console.log(text));
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}
