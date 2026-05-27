import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    vi.doUnmock("node:fs");
    vi.doUnmock("node:os");
    vi.resetModules();
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

  it("defaults to homedir() and the no-op warning sink when options are omitted", async () => {
    vi.resetModules();
    vi.doMock("node:os", () => ({ homedir: () => home }));
    const mod = await import("../runtime/skills/index.js");
    const dir = join(home, ".claude/skills/broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "no frontmatter here\n");

    const skills = await mod.discoverClaudeCodeSkills();

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

  it("logs and skips plugin roots that cannot be enumerated", async () => {
    const pluginsRoot = join(home, ".claude", "plugins");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(pluginsRoot, "not a directory");
    const warnings: string[] = [];

    const skills = await discoverClaudeCodeSkills({ home, warn: (m) => warnings.push(m) });

    expect(skills).toEqual([]);
    expect(warnings.some((w) => w.includes("cannot enumerate"))).toBe(true);
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

  it("skips skill directories without SKILL.md", async () => {
    mkdirSync(join(home, ".claude/skills/no-file"), { recursive: true });

    const skills = await discoverClaudeCodeSkills({ home });

    expect(skills).toEqual([]);
  });

  it("skips descriptors that fail schema validation", async () => {
    writeSkill(".claude/skills", "bad", "name: bad name\ndescription: Invalid name");
    const warnings: string[] = [];

    const skills = await discoverClaudeCodeSkills({ home, warn: (m) => warnings.push(m) });

    expect(skills).toEqual([]);
    expect(warnings.some((w) => w.includes("descriptor failed validation"))).toBe(true);
  });

  it("skips unreadable skill files", async () => {
    const dir = join(home, ".claude/skills/unreadable");
    mkdirSync(join(dir, "SKILL.md"), { recursive: true });
    const warnings: string[] = [];

    const skills = await discoverClaudeCodeSkills({ home, warn: (m) => warnings.push(m) });

    expect(skills).toEqual([]);
    expect(warnings.some((w) => w.includes("cannot read"))).toBe(true);
  });

  it("skips malformed YAML frontmatter", async () => {
    writeSkill(".claude/skills", "broken-yaml", "description: [unterminated");
    const warnings: string[] = [];

    const skills = await discoverClaudeCodeSkills({ home, warn: (m) => warnings.push(m) });

    expect(skills).toEqual([]);
    expect(warnings.some((w) => w.includes("malformed YAML frontmatter"))).toBe(true);
  });

  it("skips non-object YAML frontmatter", async () => {
    writeSkill(".claude/skills", "not-object", "- just\n- a-list");
    const warnings: string[] = [];

    const skills = await discoverClaudeCodeSkills({ home, warn: (m) => warnings.push(m) });

    expect(skills).toEqual([]);
    expect(warnings.some((w) => w.includes("YAML frontmatter is not an object"))).toBe(true);
  });

  it("sorts results deterministically (namespace then name) so the upload payload hashes stably", async () => {
    writeSkill(".claude/skills", "zeta", "name: zeta\ndescription: z");
    writeSkill(".claude/skills", "alpha", "name: alpha\ndescription: a");
    writeSkill(".claude/plugins/hyperframes/skills", "beta", "name: beta\ndescription: b");
    writeSkill(".claude/plugins/alpha-plugin/skills", "omega", "name: omega\ndescription: o");
    const skills = await discoverClaudeCodeSkills({ home });
    expect(skills.map((s) => `${s.namespace ?? ""}:${s.name}`)).toEqual([
      ":alpha",
      ":zeta",
      "alpha-plugin:omega",
      "hyperframes:beta",
    ]);
  });

  it("logs non-Error directory enumeration failures", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        existsSync: () => true,
        readdirSync: () => {
          throw "scan failed";
        },
      };
    });
    const mod = await import("../runtime/skills/index.js");
    const warnings: string[] = [];

    const skills = await mod.discoverClaudeCodeSkills({ home, warn: (m) => warnings.push(m) });

    expect(skills).toEqual([]);
    expect(warnings.some((w) => w.includes("scan failed"))).toBe(true);
  });
});
