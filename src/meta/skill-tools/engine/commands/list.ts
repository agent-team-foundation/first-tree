/**
 * `first-tree skill list` — print the four skill payloads with their
 * installed status and version.
 */

import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { allSkillLayouts } from "#meta/skill-tools/engine/lib/paths.js";

export interface ListDeps {
  targetRoot?: string;
  write?: (text: string) => void;
}

interface SkillStatus {
  readonly name: string;
  readonly installed: boolean;
  readonly version: string | null;
  readonly agentsKind: "missing" | "symlink" | "directory";
  readonly agentsTarget: string | null;
  readonly claudeKind: "missing" | "symlink" | "directory";
  readonly claudeTarget: string | null;
}

function readVersion(skillDir: string): string | null {
  const versionPath = join(skillDir, "VERSION");
  if (!existsSync(versionPath)) return null;
  try {
    return readFileSync(versionPath, "utf-8").trim();
  } catch {
    return null;
  }
}

function inspectEntry(
  path: string,
): { kind: "missing" | "symlink" | "directory"; target: string | null } {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      return { kind: "symlink", target: readlinkSync(path) };
    }
    if (stat.isDirectory()) {
      return { kind: "directory", target: null };
    }
  } catch {
    // falls through
  }
  return { kind: "missing", target: null };
}

export function collectSkillStatus(targetRoot: string): readonly SkillStatus[] {
  return allSkillLayouts().map((layout) => {
    const agentsFull = join(targetRoot, layout.agentsPath);
    const claudeFull = join(targetRoot, layout.claudePath);
    const agents = inspectEntry(agentsFull);
    const claude = inspectEntry(claudeFull);
    const installed = agents.kind !== "missing" && claude.kind !== "missing";
    return {
      name: layout.name,
      installed,
      version: installed ? readVersion(agentsFull) : null,
      agentsKind: agents.kind,
      agentsTarget: agents.target,
      claudeKind: claude.kind,
      claudeTarget: claude.target,
    };
  });
}

export function runList(
  args: readonly string[],
  deps: ListDeps = {},
): number {
  if (args[0] === "--help" || args[0] === "-h") {
    (deps.write ?? console.log)(`usage: first-tree skill list

  Prints the four first-tree skills with their installed status and
  version, as seen from the current working directory (or --root
  <path>).

Options:
  --root <path>         Inspect a different directory (default: cwd)
`);
    return 0;
  }

  const write = deps.write ?? ((text: string) => process.stdout.write(text + "\n"));
  let targetRoot = deps.targetRoot ?? process.cwd();
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--root" && args[i + 1]) {
      targetRoot = args[i + 1]!;
      i += 1;
    }
  }

  const rows = collectSkillStatus(targetRoot);
  const nameWidth = Math.max(...rows.map((r) => r.name.length));
  const header = `${"NAME".padEnd(nameWidth)}  STATUS     VERSION`;
  write(header);
  write("-".repeat(header.length));
  for (const row of rows) {
    const status = row.installed ? "installed" : "missing";
    const version = row.version ?? "-";
    write(`${row.name.padEnd(nameWidth)}  ${status.padEnd(9)}  ${version}`);
  }
  return 0;
}
