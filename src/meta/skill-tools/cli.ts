/**
 * Skill maintenance-namespace dispatcher.
 *
 * Routes `first-tree skill <command>` into cross-cutting skill tooling:
 * listing installed skills, diagnosing their health, repairing the
 * .claude/ alias symlinks that point into .agents/, and reinstalling the
 * shipped skill payloads.
 */

import { readOwnVersion } from "#shared/version.js";

export const SKILL_USAGE = `usage: first-tree skill <command>

  Tools for inspecting and repairing the four bundled first-tree skills
  (first-tree, tree, breeze, gardener).

Commands:
  install               Install the four skills into .agents/ and .claude/
  upgrade               Wipe and reinstall the four skills from this package
  list                  Print the four skills with installed status + version
  doctor                Diagnose skill-install health (exits non-zero on problems)
  link                  Idempotently repair .claude/skills/* symlinks

Options:
  --help, -h            Show this help message
  --version, -v         Show the skill maintenance-namespace version

Examples:
  first-tree skill install
  first-tree skill upgrade
  first-tree skill list
  first-tree skill doctor
  first-tree skill link --root /path/to/repo
`;

type Output = (text: string) => void;

function readSkillVersion(): string {
  return readOwnVersion(import.meta.url, "src/meta/skill-tools");
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
    case "install": {
      const { runInstall } = await import("./engine/commands/install.js");
      return runInstall(rest, { write });
    }
    case "upgrade": {
      const { runUpgrade } = await import("./engine/commands/upgrade.js");
      return runUpgrade(rest, { write });
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
