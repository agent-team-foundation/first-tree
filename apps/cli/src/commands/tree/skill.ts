import { resolve } from "node:path";

import type { Command } from "commander";

import type { CommandContext, SubcommandModule } from "../types.js";
import {
  CORE_SKILL_NAMES,
  collectSkillDiagnosis,
  collectSkillStatus,
  copyCanonicalSkills,
  copyCoreSkills,
  type RetiredSkillPruneResult,
  repairClaudeSkillLinks,
  SKILL_NAMES,
} from "./skill-lib.js";

const ROOT_OPTION_DESCRIPTION = "operate on a different root (default: cwd)";

function configureRootOption(command: Command): void {
  command.option("--root <path>", ROOT_OPTION_DESCRIPTION);
}

function readTargetRoot(command: Command): string {
  const options = command.opts() as { root?: string };
  return resolve(options.root ?? process.cwd());
}

function logPrunedRetiredSkills(result: RetiredSkillPruneResult): void {
  for (const path of result.removed) {
    console.log(`pruned retired skill: ${path}`);
  }
  for (const path of result.skipped) {
    console.log(`left foreign install alone (retired skill name): ${path}`);
  }
}

function runInstallSkillCommand(context: CommandContext): void {
  const targetRoot = readTargetRoot(context.command);
  const pruneResult = copyCanonicalSkills(targetRoot);
  logPrunedRetiredSkills(pruneResult);
  console.log(`Installed ${SKILL_NAMES.length} shipped first-tree skills into ${targetRoot}.`);
}

function runUpgradeSkillCommand(context: CommandContext): void {
  const targetRoot = readTargetRoot(context.command);
  const pruneResult = copyCanonicalSkills(targetRoot);
  logPrunedRetiredSkills(pruneResult);
  console.log(`Upgraded ${SKILL_NAMES.length} shipped first-tree skills in ${targetRoot}.`);
}

function runInstallCoreSkillCommand(context: CommandContext): void {
  const targetRoot = readTargetRoot(context.command);
  copyCoreSkills(targetRoot);
  console.log(`Installed ${CORE_SKILL_NAMES.length} core first-tree skill(s) into ${targetRoot}.`);
}

function listStatusLabel(row: { installed: boolean; compatible: boolean | null }): string {
  if (!row.installed) return "missing";
  if (row.compatible === false) return "incompatible";
  return "installed";
}

function runListSkillCommand(context: CommandContext): void {
  const targetRoot = readTargetRoot(context.command);
  const rows = collectSkillStatus(targetRoot);

  if (context.options.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  const nameWidth = Math.max(...rows.map((row) => row.name.length));
  const compatWidth = Math.max(...rows.map((row) => (row.cliCompat ?? "-").length), 10);
  const statusWidth = "incompatible".length;
  console.log(
    `${"NAME".padEnd(nameWidth)}  ${"STATUS".padEnd(statusWidth)}  VERSION        CLI COMPAT`.padEnd(
      nameWidth + statusWidth + compatWidth + 21,
    ),
  );
  console.log("-".repeat(nameWidth + statusWidth + compatWidth + 21));
  for (const row of rows) {
    console.log(
      `${row.name.padEnd(nameWidth)}  ${listStatusLabel(row).padEnd(statusWidth)}  ${(row.version ?? "-").padEnd(13)} ${(row.cliCompat ?? "-").padEnd(compatWidth)}`,
    );
  }
}

function runDoctorSkillCommand(context: CommandContext): void {
  const targetRoot = readTargetRoot(context.command);
  const rows = collectSkillDiagnosis(targetRoot);

  if (context.options.json) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log("=== first-tree tree skill doctor ===");
    console.log("");
    for (const row of rows) {
      if (row.ok) {
        console.log(`  OK ${row.name}`);
        continue;
      }

      console.log(`  FAIL ${row.name}`);
      for (const problem of row.problems) {
        console.log(`    - ${problem}`);
      }
    }
  }

  const failingRows = rows.filter((row) => !row.ok);
  if (failingRows.length > 0) {
    if (!context.options.json) {
      const incompatible = failingRows.filter((row) => row.incompatibleCliCompat !== null);
      const otherFailures = failingRows.filter((row) => row.incompatibleCliCompat === null);
      const cliVersion = rows[0]?.cliVersion ?? "unknown";

      console.log("");
      console.log(`Found problems in ${failingRows.length} of ${rows.length} skills.`);

      if (incompatible.length > 0) {
        console.log("");
        console.log(`The current CLI version is ${cliVersion}.`);
        console.log("These skills require a different CLI version — pin the CLI to a satisfying");
        console.log("range, or downgrade the skill payload to one that lists this CLI:");
        for (const row of incompatible) {
          console.log(`  ${row.name} requires first-tree ${row.incompatibleCliCompat}`);
        }
      }

      if (otherFailures.length > 0) {
        console.log("");
        console.log("Repair shipped skill payloads with:");
        console.log("  first-tree tree skill link");
        console.log("  first-tree tree skill upgrade");
      }
    }
    process.exitCode = 1;
  }
}

function runLinkSkillCommand(context: CommandContext): void {
  const targetRoot = readTargetRoot(context.command);
  const result = repairClaudeSkillLinks(targetRoot);

  for (const message of result.messages) {
    console.log(message);
  }
  console.log("");
  console.log(`Linked ${result.linked} symlink(s); skipped ${result.skipped} skill(s) without an .agents install.`);
}

export const skillSubcommands: SubcommandModule[] = [
  {
    name: "install",
    alias: "",
    summary: "",
    description: "Install shipped first-tree skills into local agent directories.",
    action: runInstallSkillCommand,
    configure: configureRootOption,
  },
  {
    name: "upgrade",
    alias: "",
    summary: "",
    description: "Reinstall shipped first-tree skills from the current package.",
    action: runUpgradeSkillCommand,
    configure: configureRootOption,
  },
  {
    name: "install-core",
    alias: "",
    summary: "",
    description:
      "Install only the core first-tree skills (currently none). Used by the client's per-session workspace bootstrap so on-disk skill payloads exist even for agents without a Context Tree binding.",
    action: runInstallCoreSkillCommand,
    configure: configureRootOption,
  },
  {
    name: "list",
    alias: "",
    summary: "",
    description: "List the installed first-tree skill payloads and versions.",
    action: runListSkillCommand,
    configure: configureRootOption,
  },
  {
    name: "doctor",
    alias: "",
    summary: "",
    description: "Diagnose first-tree skill installation health.",
    action: runDoctorSkillCommand,
    configure: configureRootOption,
  },
  {
    name: "link",
    alias: "",
    summary: "",
    description: "Repair .claude skill aliases that point to .agents skills.",
    action: runLinkSkillCommand,
    configure: configureRootOption,
  },
];
