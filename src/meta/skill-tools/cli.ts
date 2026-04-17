/**
 * Skill-tools meta dispatcher.
 *
 * Routes `first-tree skill <command>` into cross-cutting skill tooling:
 * listing installed skills, diagnosing their health, and repairing the
 * .claude/ alias symlinks that point into .agents/.
 *
 * This is a META command, not a product — it manages the four skill
 * payloads (first-tree + tree/breeze/gardener) rather than shipping one
 * of its own. The `first-tree skill` command family is the user-facing
 * entry point an agent reaches for when the first-tree skill's
 * "Managing Skills On This Machine" section sends them here.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_USAGE = `usage: first-tree skill <command>

  Tools for inspecting and repairing the four bundled first-tree skills
  (first-tree, tree, breeze, gardener).

Commands:
  list                  Print the four skills with installed status + version
  doctor                Diagnose skill-install health (exits non-zero on problems)
  link                  Idempotently repair .claude/skills/* symlinks

Options:
  --help, -h            Show this help message
  --version, -v         Show skill product version

Examples:
  first-tree skill list
  first-tree skill doctor
  first-tree skill link --root /path/to/repo
`;

type Output = (text: string) => void;

function readSkillVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "VERSION"),
    join(here, "..", "..", "..", "src", "meta", "skill-tools", "VERSION"),
    join(here, "..", "src", "meta", "skill-tools", "VERSION"),
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf-8").trim();
    } catch {
      // try next
    }
  }
  return "unknown";
}

export async function runSkill(
  args: string[],
  output: Output = console.log,
): Promise<number> {
  const write = (text: string): void => output(text);

  if (
    args.length === 0 ||
    args[0] === "--help" ||
    args[0] === "-h" ||
    args[0] === "help"
  ) {
    write(SKILL_USAGE);
    return 0;
  }

  if (args[0] === "--version" || args[0] === "-v") {
    write(readSkillVersion());
    return 0;
  }

  const command = args[0];
  const rest = args.slice(1);

  switch (command) {
    case "list": {
      const { runList } = await import("./engine/commands/list.js");
      return runList(rest, { write });
    }
    case "doctor": {
      const { runDoctor } = await import("./engine/commands/doctor.js");
      return runDoctor(rest, { write });
    }
    case "link": {
      const { runLink } = await import("./engine/commands/link.js");
      return runLink(rest, { write });
    }
    default:
      write(`Unknown skill command: ${command}`);
      write(SKILL_USAGE);
      return 1;
  }
}
