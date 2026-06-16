#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

function fail(message) {
  process.stderr.write(`validate-skills: ${message}\n`);
  process.exitCode = 1;
}

function parseFrontmatter(text, skillMdPath) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match) {
    fail(`${skillMdPath}: missing YAML frontmatter`);
    return null;
  }

  const fields = new Map();
  for (const rawLine of match[1].split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const fieldMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/u);
    if (!fieldMatch) continue;
    fields.set(fieldMatch[1], fieldMatch[2].replace(/^["']|["']$/gu, "").trim());
  }
  return fields;
}

function validateSkillDir(inputPath) {
  const skillDir = resolve(inputPath);
  const skillName = basename(skillDir);
  const skillMdPath = resolve(skillDir, "SKILL.md");

  if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) {
    fail(`${skillDir}: directory does not exist`);
    return;
  }
  if (!existsSync(skillMdPath) || !statSync(skillMdPath).isFile()) {
    fail(`${skillMdPath}: file does not exist`);
    return;
  }

  const skillText = readFileSync(skillMdPath, "utf-8");
  const fields = parseFrontmatter(skillText, skillMdPath);
  if (!fields) return;

  const name = fields.get("name");
  if (!name) {
    fail(`${skillMdPath}: frontmatter name is required`);
  } else if (name !== skillName) {
    fail(`${skillMdPath}: frontmatter name must equal directory name (${skillName})`);
  }

  const description = fields.get("description");
  if (!description) {
    fail(`${skillMdPath}: frontmatter description is required`);
  }

  const versionPath = resolve(skillDir, "VERSION");
  if (existsSync(versionPath) && readFileSync(versionPath, "utf-8").trim() === "") {
    fail(`${versionPath}: VERSION must not be empty when present`);
  }
}

const skillDirs = process.argv.slice(2);
if (skillDirs.length === 0) {
  fail("usage: node scripts/validate-skills.mjs <skill-dir> [<skill-dir> ...]");
} else {
  for (const dir of skillDirs) {
    validateSkillDir(dir);
  }
}

if (process.exitCode) {
  process.exit();
}
process.stdout.write(`validate-skills: validated ${skillDirs.length} skill(s)\n`);
