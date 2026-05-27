import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverClaudeCodeSkills } from "../runtime/skills/index.js";

/**
 * `discoverClaudeCodeSkills` walks the well-known Claude Code skill paths
 * under `$HOME/.claude/` and returns one descriptor per SKILL.md. The
 * scanner deliberately tolerates malformed files (logs a warning, skips)
 * because the daemon must not crash on a single broken skill payload.
 */
describe("discoverClaudeCodeSkills", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ft-skills-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function writeSkill(relDir: string, name: string, frontmatter: string, body = "Body"): void {
    const dir = join(home, relDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}\n`);
  }

  it("returns an empty list when the .claude tree is missing", async () => {
    const skills = await discoverClaudeCodeSkills({ home });
    expect(skills).toEqual([]);
  });

  it("picks up user-global skills under .claude/skills/<name>/SKILL.md", async () => {
    writeSkill(".claude/skills", "review", "name: review\ndescription: Pre-landing PR review");
    writeSkill(".claude/skills", "ship", "name: ship\ndescription: Ship workflow");
    const skills = await discoverClaudeCodeSkills({ home });
    expect(skills).toEqual([
      { name: "review", description: "Pre-landing PR review", source: "user" },
      { name: "ship", description: "Ship workflow", source: "user" },
    ]);
  });

  it("tags plugin skills with the plugin dir name as namespace", async () => {
    writeSkill(".claude/plugins/hyperframes/skills", "gsap", "name: gsap\ndescription: GSAP animation reference");
    const skills = await discoverClaudeCodeSkills({ home });
    expect(skills).toEqual([
      { name: "gsap", namespace: "hyperframes", description: "GSAP animation reference", source: "plugin" },
    ]);
  });

  it("falls back to the directory name when frontmatter omits `name`", async () => {
    writeSkill(".claude/skills", "my-skill", "description: No explicit name field");
    const skills = await discoverClaudeCodeSkills({ home });
    expect(skills).toEqual([{ name: "my-skill", description: "No explicit name field", source: "user" }]);
  });

  it("skips files with missing frontmatter and surfaces a warning", async () => {
    const dir = join(home, ".claude/skills/broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "no frontmatter here\n");
    // Plus a good one so we know the scan continues past the broken entry.
    writeSkill(".claude/skills", "good", "name: good\ndescription: Working skill");

    const warnings: string[] = [];
    const skills = await discoverClaudeCodeSkills({ home, warn: (m) => warnings.push(m) });
    expect(skills).toEqual([{ name: "good", description: "Working skill", source: "user" }]);
    expect(warnings.some((w) => w.includes("missing YAML frontmatter"))).toBe(true);
  });

  it("skips files whose frontmatter is missing required `description`", async () => {
    writeSkill(".claude/skills", "incomplete", "name: incomplete");
    const warnings: string[] = [];
    const skills = await discoverClaudeCodeSkills({ home, warn: (m) => warnings.push(m) });
    expect(skills).toEqual([]);
    expect(warnings.some((w) => w.includes("missing required `description`"))).toBe(true);
  });

  it("sorts results deterministically (namespace then name) so the upload payload hashes stably", async () => {
    writeSkill(".claude/skills", "zeta", "name: zeta\ndescription: z");
    writeSkill(".claude/skills", "alpha", "name: alpha\ndescription: a");
    writeSkill(".claude/plugins/hyperframes/skills", "beta", "name: beta\ndescription: b");
    const skills = await discoverClaudeCodeSkills({ home });
    expect(skills.map((s) => `${s.namespace ?? ""}:${s.name}`)).toEqual([":alpha", ":zeta", "hyperframes:beta"]);
  });
});
