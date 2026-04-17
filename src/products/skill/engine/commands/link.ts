/**
 * `first-tree skill link` — idempotently (re)create the .claude/skills/
 * symlinks that point into .agents/skills/.
 *
 * Intended for the case where .agents/skills/<name>/ exists (it was
 * installed by `first-tree tree upgrade`) but the .claude/skills/<name>
 * alias is missing or pointing at the wrong target — e.g. after a user
 * manually edited one of the directories or restored a backup.
 *
 * This command does NOT install skill payloads; it only wires up the
 * Claude Code alias symlinks from an existing .agents/ install.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { allSkillLayouts } from "#products/skill/engine/lib/paths.js";

export interface LinkDeps {
  targetRoot?: string;
  write?: (text: string) => void;
}

export function runLink(
  args: readonly string[],
  deps: LinkDeps = {},
): number {
  if (args[0] === "--help" || args[0] === "-h") {
    (deps.write ?? console.log)(`usage: first-tree skill link

  Idempotently (re)creates the .claude/skills/<name> symlinks pointing
  at the matching .agents/skills/<name> entries for all four first-tree
  skills. Safe to re-run; skips skills that do not have a
  .agents/skills/<name>/ install to link to.

Options:
  --root <path>         Operate against a different directory (default: cwd)
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

  let linked = 0;
  let skipped = 0;
  for (const layout of allSkillLayouts()) {
    const agentsFull = join(targetRoot, layout.agentsPath);
    const claudeFull = join(targetRoot, layout.claudePath);
    if (!existsSync(agentsFull)) {
      skipped += 1;
      continue;
    }

    try {
      const stat = lstatSync(claudeFull);
      if (stat.isSymbolicLink()) {
        const actual = readlinkSync(claudeFull);
        if (actual === layout.claudeSymlinkTarget) {
          continue;
        }
      }
      rmSync(claudeFull, { recursive: true, force: true });
    } catch {
      // claudeFull does not exist — fall through to create it.
    }

    mkdirSync(dirname(claudeFull), { recursive: true });
    symlinkSync(layout.claudeSymlinkTarget, claudeFull);
    linked += 1;
    write(`  linked ${layout.claudePath} -> ${layout.claudeSymlinkTarget}`);
  }

  write("");
  write(
    `Linked ${linked} symlink(s); skipped ${skipped} skill(s) with no .agents/ install.`,
  );
  if (skipped > 0) {
    write("Run `first-tree tree upgrade` to install the missing skills.");
  }
  return 0;
}
