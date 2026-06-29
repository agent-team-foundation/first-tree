import { readFileSync } from "node:fs";

export type SkillFrontmatter = {
  description: string;
  name: string;
};

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseSkillFrontmatter(markdown: string): SkillFrontmatter {
  const lines = markdown.split(/\r?\n/u);
  if (lines[0] !== "---") {
    throw new Error("missing frontmatter opening marker.");
  }

  const values = new Map<string, string>();
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    if (line === "---") break;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u.exec(line);
    if (match) {
      const key = match[1];
      const value = match[2];
      if (key !== undefined && value !== undefined) {
        values.set(key, unquote(value));
      }
    }
  }

  const name = values.get("name");
  const description = values.get("description");
  if (!name) {
    throw new Error("missing frontmatter name.");
  }
  if (!description) {
    throw new Error("missing frontmatter description.");
  }

  return { description, name };
}

export function readSkillFrontmatter(skillMarkdownPath: string): SkillFrontmatter {
  return parseSkillFrontmatter(readFileSync(skillMarkdownPath, "utf8"));
}
