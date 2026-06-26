import { chmodSync } from "node:fs";
import { join } from "node:path";

import { writeText } from "../commands.js";
import { writeShellPathBootstrap } from "../paths.js";
import type { RunPaths } from "../types.js";

export function createFirstTreeShim(paths: RunPaths): void {
  const tsxBin = join(paths.packageRoot, "node_modules", ".bin", "tsx");
  const cliEntry = join(paths.repoRoot, "apps", "cli", "src", "cli", "index.ts");
  const shimPath = join(paths.binDir, "first-tree");
  const script = `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const EVENTS_PATH = ${JSON.stringify(paths.eventsPath)};
const TSX_BIN = ${JSON.stringify(tsxBin)};
const CLI_ENTRY = ${JSON.stringify(cliEntry)};

function preview(value) {
  if (!value) return "";
  return value.length <= 4000 ? value : value.slice(0, 4000) + "...<truncated " + (value.length - 4000) + " chars>";
}

function append(event) {
  appendFileSync(EVENTS_PATH, JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + "\\n", "utf8");
}

function formatArg(arg) {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function commandLine(argv) {
  return argv.map(formatArg).join(" ");
}

function trace(message) {
  if (process.env.FIRST_TREE_EVAL_VERBOSE === "1") {
    const caseId = process.env.FIRST_TREE_EVAL_CASE_ID || "unknown";
    process.stderr.write("[" + caseId + "] " + message + "\\n");
  }
}

const argv = process.argv.slice(2);
const phase = process.env.FIRST_TREE_EVAL_PHASE || "model";
append({ type: "first_tree_call", phase, argv, cwd: process.cwd() });
trace("first-tree call: " + commandLine(argv));

const realCommand = process.env.FIRST_TREE_EVAL_REAL_FIRST_TREE || TSX_BIN;
const realArgs = process.env.FIRST_TREE_EVAL_REAL_FIRST_TREE ? argv : [CLI_ENTRY, ...argv];
const result = spawnSync(realCommand, realArgs, {
  cwd: process.cwd(),
  encoding: "utf8",
  env: process.env,
  maxBuffer: 20 * 1024 * 1024,
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

if (result.error) {
  append({
    type: "first_tree_result",
    phase,
    argv,
    cwd: process.cwd(),
    exitCode: 127,
    error: String(result.error),
    stdoutPreview: preview(result.stdout || ""),
    stderrPreview: preview(result.stderr || ""),
  });
  trace("first-tree result: exit=127 error=" + preview(String(result.error)));
  process.exit(127);
}

const exitCode = result.status == null ? 1 : result.status;
append({
  type: "first_tree_result",
  phase,
  argv,
  cwd: process.cwd(),
  exitCode,
  signal: result.signal || null,
  stdoutPreview: preview(result.stdout || ""),
  stderrPreview: preview(result.stderr || ""),
});
trace("first-tree result: exit=" + exitCode);

process.exit(exitCode);
`;

  writeText(shimPath, script);
  chmodSync(shimPath, 0o755);
  writeShellPathBootstrap(paths);
}
