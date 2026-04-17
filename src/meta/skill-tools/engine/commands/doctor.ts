/**
 * `first-tree skill doctor` — diagnose skill install health.
 */

import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import {
  allSkillLayouts,
  requiredFilesForSkill,
} from "#meta/skill-tools/engine/lib/paths.js";

export interface DoctorDeps {
  targetRoot?: string;
  write?: (text: string) => void;
}

interface Diagnosis {
  readonly name: string;
  readonly problems: string[];
}

function inspect(targetRoot: string, name: string): Diagnosis {
  const problems: string[] = [];
  const layout = allSkillLayouts().find((l) => l.name === name)!;
  const agentsFull = join(targetRoot, layout.agentsPath);
  const claudeFull = join(targetRoot, layout.claudePath);

  if (!existsSync(agentsFull)) {
    problems.push(`missing: ${layout.agentsPath}`);
  } else {
    for (const relPath of requiredFilesForSkill(name)) {
      const fullPath = join(agentsFull, relPath);
      if (!existsSync(fullPath)) {
        problems.push(`${layout.agentsPath}/${relPath} does not exist`);
      }
    }
  }

  if (!existsSync(claudeFull)) {
    problems.push(`missing: ${layout.claudePath}`);
  } else {
    try {
      const stat = lstatSync(claudeFull);
      if (!stat.isSymbolicLink()) {
        problems.push(
          `${layout.claudePath} should be a symlink to ${layout.claudeSymlinkTarget}`,
        );
      } else {
        const actual = readlinkSync(claudeFull);
        if (actual !== layout.claudeSymlinkTarget) {
          problems.push(
            `${layout.claudePath} -> ${actual}, expected ${layout.claudeSymlinkTarget}`,
          );
        }
      }
    } catch {
      problems.push(`${layout.claudePath} is unreadable`);
    }
  }

  return { name, problems };
}

export function runDoctor(
  args: readonly string[],
  deps: DoctorDeps = {},
): number {
  if (args[0] === "--help" || args[0] === "-h") {
    (deps.write ?? console.log)(`usage: first-tree skill doctor

  Diagnoses the health of the four first-tree skill installs in the
  current working directory (or --root <path>). Reports per-skill
  presence, required-file completeness, and symlink target correctness.

  Exits 0 if all four skills are healthy, 1 otherwise.

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

  write("=== first-tree skill doctor ===");
  write("");
  let bad = 0;
  for (const layout of allSkillLayouts()) {
    const diag = inspect(targetRoot, layout.name);
    if (diag.problems.length === 0) {
      write(`  ✓ ${layout.name}`);
    } else {
      bad += 1;
      write(`  ✗ ${layout.name}`);
      for (const problem of diag.problems) {
        write(`      - ${problem}`);
      }
    }
  }
  write("");
  if (bad === 0) {
    write("All four skills are installed and healthy.");
    return 0;
  }
  write(`${bad} of 4 skills have problems.`);
  write("");
  write("Fix with:");
  write("  first-tree skill link     # repair symlinks");
  write("  first-tree skill upgrade  # reinstall all four skills");
  return 1;
}
