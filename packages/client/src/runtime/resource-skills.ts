import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRuntimeConfigPayload, RuntimeResourceSkill } from "@first-tree/shared";
import type { SessionContext } from "./handler.js";

export function resourceSkillPath(workspace: string, resourceId: string): string {
  return join(workspace, ".first-tree", "resources", "skills", resourceId, "SKILL.md");
}

function resourceSkillsDir(workspace: string): string {
  return join(workspace, ".first-tree", "resources", "skills");
}

export async function materializeResourceSkills(
  workspace: string,
  payload: AgentRuntimeConfigPayload | null | undefined,
  sessionCtx: SessionContext,
): Promise<void> {
  const skills = payload?.resourceSkills ?? [];
  const root = resourceSkillsDir(workspace);
  await mkdir(root, { recursive: true });
  const activeIds = new Set(skills.map((skill) => skill.resourceId));
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || activeIds.has(entry.name)) continue;
    const stalePath = join(root, entry.name);
    await rm(stalePath, { recursive: true, force: true });
    sessionCtx.log(`Resource skill pruned: ${stalePath}`);
  }
  for (const skill of skills) {
    const target = resourceSkillPath(workspace, skill.resourceId);
    await mkdir(join(root, skill.resourceId), { recursive: true });
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
  const meta = Object.keys(skill.metadata).length > 0 ? JSON.stringify(skill.metadata) : "{}";
  return [
    "---",
    `name: ${quoteYamlScalar(skill.name)}`,
    `description: ${quoteYamlScalar(skill.description)}`,
    `metadata: ${meta}`,
    "---",
    "",
    skill.body,
    "",
  ].join("\n");
}

function quoteYamlScalar(value: string): string {
  return JSON.stringify(value);
}
