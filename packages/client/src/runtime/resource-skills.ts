import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRuntimeConfigPayload, RuntimeResourceSkill } from "@first-tree/shared";
import type { SessionContext } from "./handler.js";

export function resourceSkillPath(workspace: string, resourceId: string): string {
  return join(workspace, ".first-tree", "resources", "skills", resourceId, "SKILL.md");
}

export async function materializeResourceSkills(
  workspace: string,
  payload: AgentRuntimeConfigPayload | null | undefined,
  sessionCtx: SessionContext,
): Promise<void> {
  const skills = payload?.resourceSkills ?? [];
  for (const skill of skills) {
    const target = resourceSkillPath(workspace, skill.resourceId);
    await mkdir(join(workspace, ".first-tree", "resources", "skills", skill.resourceId), { recursive: true });
    await writeFile(target, buildSkillMarkdown(skill), "utf-8");
    sessionCtx.log(`Resource skill materialized: ${skill.name} -> ${target}`);
  }
}

export function buildResourceSkillsBriefing(
  workspace: string,
  payload: AgentRuntimeConfigPayload | null | undefined,
): string {
  const skills = payload?.resourceSkills ?? [];
  if (skills.length === 0) return "";
  const lines = ["## Team Skills", ""];
  for (const skill of skills) {
    lines.push(`- ${skill.name}: ${skill.description || "No description"}`);
    lines.push(`  Path: ${resourceSkillPath(workspace, skill.resourceId)}`);
  }
  return lines.join("\n");
}

function buildSkillMarkdown(skill: RuntimeResourceSkill): string {
  const meta = Object.keys(skill.metadata).length > 0 ? JSON.stringify(skill.metadata, null, 2) : "{}";
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    `metadata: ${meta}`,
    "---",
    "",
    skill.body,
    "",
  ].join("\n");
}
