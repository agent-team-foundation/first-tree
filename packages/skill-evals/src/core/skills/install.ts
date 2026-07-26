import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseDocument } from "yaml";

import { writeText } from "../commands.js";

export function parseSkillDescription(skillMarkdown: string): string {
  const frontmatter = skillMarkdown.match(/^---\n([\s\S]*?)\n---/u)?.[1];
  if (frontmatter) {
    try {
      const description = parseDocument(frontmatter).get("description");
      if (typeof description === "string" && description.trim() !== "") {
        return description;
      }
    } catch (error: unknown) {
      void error;
      // Fall back to the legacy line parser for malformed test fixtures.
    }
  }

  const match = skillMarkdown.match(/^description:\s*"?(.+?)"?\s*$/mu);
  return match?.[1] ?? "Use this skill when its description applies.";
}

export function installRepoSkill(repoRoot: string, workspacePath: string, skillName: string): string {
  const sourceDir = join(repoRoot, "skills", skillName);
  const agentsDir = join(workspacePath, ".agents", "skills", skillName);
  const claudeDir = join(workspacePath, ".claude", "skills");
  const claudeLink = join(claudeDir, skillName);
  const skillPath = join(sourceDir, "SKILL.md");

  if (!existsSync(skillPath)) {
    throw new Error(`Missing source skill: ${sourceDir}`);
  }

  rmSync(agentsDir, { force: true, recursive: true });
  mkdirSync(dirname(agentsDir), { recursive: true });
  cpSync(sourceDir, agentsDir, { recursive: true });

  rmSync(claudeLink, { force: true, recursive: true });
  mkdirSync(claudeDir, { recursive: true });
  symlinkSync(join("..", "..", ".agents", "skills", skillName), claudeLink, "dir");

  return readFileSync(skillPath, "utf8");
}

export function writeSingleSkillAgentsMarkdown(
  workspacePath: string,
  skillName: string,
  skillDescription: string,
): void {
  writeText(
    join(workspacePath, "AGENTS.md"),
    `# Eval Workspace Instructions

Use installed skills only when the skill description applies to the user's
prompt. Do not call \`first-tree\` for casual or unrelated prompts.

## Available Skills

| Skill | Load when |
|---|---|
| \`${skillName}\` | ${skillDescription} |

When \`${skillName}\` applies, load it by reading
\`.agents/skills/${skillName}/SKILL.md\` before acting. Follow the loaded
skill workflow exactly.
`,
  );
}
