/**
 * Shared helpers for skill CLI commands. All paths are relative to a
 * user-facing `targetRoot` (the repo or workspace the agent is running
 * against). The four skill names live in asset-loader.ts so both the
 * installer and this command family agree on the full set.
 */

import { join } from "node:path";
import {
  ALL_SKILL_NAMES,
  INSTALLED_SKILL_REQUIRED_FILES,
} from "#products/tree/engine/runtime/asset-loader.js";

export { ALL_SKILL_NAMES };

const PRODUCT_SKILL_REQUIRED_FILES = ["SKILL.md", "VERSION"] as const;

export interface SkillLayout {
  readonly name: string;
  /** `.agents/skills/<name>/` relative to the target root. */
  readonly agentsPath: string;
  /** `.claude/skills/<name>/` relative to the target root. */
  readonly claudePath: string;
  /** Expected symlink target of agentsPath when the target root IS the
   *  first-tree source repo (i.e. the skill lives under
   *  `<targetRoot>/skills/<name>/`). */
  readonly agentsSymlinkTarget: string;
  /** Expected symlink target of claudePath (always points at the agents
   *  entry above, regardless of whether it's a symlink or a real dir). */
  readonly claudeSymlinkTarget: string;
}

export function layoutForSkill(name: string): SkillLayout {
  return {
    name,
    agentsPath: join(".agents", "skills", name),
    claudePath: join(".claude", "skills", name),
    agentsSymlinkTarget: join("..", "..", "skills", name),
    claudeSymlinkTarget: join("..", "..", ".agents", "skills", name),
  };
}

export function allSkillLayouts(): readonly SkillLayout[] {
  return ALL_SKILL_NAMES.map(layoutForSkill);
}

export function requiredFilesForSkill(name: string): readonly string[] {
  return name === "first-tree"
    ? INSTALLED_SKILL_REQUIRED_FILES
    : PRODUCT_SKILL_REQUIRED_FILES;
}
