/**
 * `first-tree skill doctor` — diagnose skill install health.
 *
 * Reports per-skill: presence of the .agents/ entry, presence of the
 * .claude/ symlink, whether the symlinks point at the expected targets,
 * and whether the SKILL.md frontmatter is readable. Exits non-zero if
 * anything is wrong so CI can gate on it.
 */

import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { allSkillLayouts } from "#meta/skill-tools/engine/lib/paths.js";

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
  const layouts = allSkillLayouts().find((l) => l.name === name)!;
  const agentsFull = join(targetRoot, layouts.agentsPath);
  const claudeFull = join(targetRoot, layouts.claudePath);

  if (!existsSync(agentsFull)) {
    problems.push(`missing: ${layouts.agentsPath}`);
  } else {
    const skillMd = join(agentsFull, "SKILL.md");
    if (!existsSync(skillMd)) {
      problems.push(`${layouts.agentsPath}/SKILL.md does not exist`);
    }
  }

  if (!existsSync(claudeFull)) {
    problems.push(`missing: ${layouts.claudePath}`);
  } else {
    try {
      const stat = lstatSync(claudeFull);
      if (!stat.isSymbolicLink()) {
        problems.push(
          `${layouts.claudePath} should be a symlink to ${layouts.claudeSymlinkTarget}`,
        );
      } else {
        const actual = readlinkSync(claudeFull);
        if (actual !== layouts.claudeSymlinkTarget) {
          problems.push(
            `${layouts.claudePath} -> ${actual}, expected ${layouts.claudeSymlinkTarget}`,
          );
        }
      }
    } catch {
      problems.push(`${layouts.claudePath} is unreadable`);
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
  presence, SKILL.md readability, and symlink target correctness.

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
  write("  first-tree skill link    # repair symlinks");
  write("  first-tree tree upgrade  # reinstall all four skills");
  return 1;
}
