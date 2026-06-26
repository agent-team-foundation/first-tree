import { chmodSync } from "node:fs";
import { join } from "node:path";

import { writeText } from "../commands.js";
import { writeShellPathBootstrap } from "../paths.js";
import type { RunPaths } from "../types.js";

export function createGhShim(paths: RunPaths): void {
  const shimPath = join(paths.binDir, "gh");
  const script = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const EVENTS_PATH = ${JSON.stringify(paths.eventsPath)};

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
append({ type: "gh_call", phase, argv, cwd: process.cwd() });
trace("gh call blocked: " + commandLine(argv));

const stderr = "Blocked gh command in skill eval. No real GitHub side effect was attempted.\\n";
process.stderr.write(stderr);
append({
  type: "gh_result",
  phase,
  argv,
  cwd: process.cwd(),
  exitCode: 1,
  signal: null,
  stdoutPreview: "",
  stderrPreview: preview(stderr),
  blockedByEval: true,
});

process.exit(1);
`;

  writeText(shimPath, script);
  chmodSync(shimPath, 0o755);
  writeShellPathBootstrap(paths);
}
