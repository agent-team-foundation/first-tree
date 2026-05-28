import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bundledSkillsRootFrom,
  collectSkillDiagnosis,
  collectSkillStatus,
  copyCanonicalSkills,
  inspectSkillEntry,
  readBundledSkillVersion,
  repairClaudeSkillLinks,
  SKILL_NAMES,
  upsertWhitepaperFile,
} from "../commands/tree/skill-lib.js";

function writeSkill(root: string, name: string, version: string, cliCompat: string): string {
  const dir = join(root, ".agents", "skills", name);
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "VERSION"), `${version}\n`);
  writeFileSync(
    join(dir, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `version: ${version}`,
      "cliCompat:",
      `  first-tree: "${cliCompat}"`,
      "---",
      "",
      `# ${name}`,
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "agents", "openai.yaml"), "name: test\n");
  return dir;
}

describe("tree skill library", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "first-tree-skill-lib-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("locates bundled skills and copies the canonical skill layout", () => {
    const nested = join(process.cwd(), "apps", "cli", "src", "commands");

    expect(bundledSkillsRootFrom(nested)).toBe(resolve(process.cwd(), "..", "..", "skills"));
    expect(readBundledSkillVersion()).toMatch(/^\d+\.\d+\.\d+/);

    copyCanonicalSkills(tmp);

    for (const name of SKILL_NAMES) {
      const agentsPath = join(tmp, ".agents", "skills", name);
      const claudePath = join(tmp, ".claude", "skills", name);
      expect(existsSync(join(agentsPath, "SKILL.md")), name).toBe(true);
      expect(inspectSkillEntry(agentsPath)).toEqual({ kind: "directory", target: null });
      expect(inspectSkillEntry(claudePath)).toEqual({
        kind: "symlink",
        target: join("..", "..", ".agents", "skills", name),
      });
    }

    const status = collectSkillStatus(tmp);
    expect(status).toHaveLength(SKILL_NAMES.length);
    expect(status.every((entry) => entry.installed)).toBe(true);
    expect(status.map((entry) => entry.name)).toEqual([...SKILL_NAMES]);

    const diagnosis = collectSkillDiagnosis(tmp);
    expect(diagnosis).toHaveLength(SKILL_NAMES.length);
    expect(diagnosis.some((entry) => entry.problems.length > 0)).toBe(true);
  });

  it("diagnoses missing, incompatible, stale, and malformed skill entries", () => {
    writeSkill(tmp, "first-tree-sync", "1.2.3", ">=999.0.0");
    writeSkill(tmp, "first-tree-write", "1.2.3", "not-a-range");
    writeSkill(tmp, "github-scan", "1.2.3", ">=0.0.0");
    writeFileSync(join(tmp, ".agents", "skills", "github-scan", "SKILL.md"), "# no frontmatter\n");
    mkdirSync(join(tmp, ".claude", "skills"), { recursive: true });
    symlinkSync("wrong-target", join(tmp, ".claude", "skills", "first-tree-sync"));
    mkdirSync(join(tmp, ".claude", "skills", "first-tree-write"), { recursive: true });

    const diagnosis = collectSkillDiagnosis(tmp);
    const byName = new Map(diagnosis.map((entry) => [entry.name, entry]));

    expect(byName.get("first-tree")?.problems).toContain("missing: .agents/skills/first-tree");
    expect(byName.get("first-tree-sync")?.incompatibleCliCompat).toBe(">=999.0.0");
    expect(byName.get("first-tree-sync")?.problems.join("\n")).toContain(
      "expected ../../.agents/skills/first-tree-sync",
    );
    expect(byName.get("first-tree-write")?.problems.join("\n")).toContain("unreadable cliCompat range");
    expect(byName.get("first-tree-write")?.problems.join("\n")).toContain("should be a symlink");
    expect(byName.get("github-scan")?.problems.join("\n")).toContain("frontmatter is missing version");
  });

  it("repairs claude symlinks and manages the whitepaper pointer", () => {
    writeSkill(tmp, "attention", "0.1.0", ">=0.0.0");
    mkdirSync(join(tmp, ".claude", "skills"), { recursive: true });
    mkdirSync(join(tmp, ".claude", "skills", "attention"), { recursive: true });

    const repair = repairClaudeSkillLinks(tmp);
    expect(repair.linked).toBe(1);
    expect(repair.skipped).toBe(SKILL_NAMES.length - 1);
    expect(readlinkSync(join(tmp, ".claude", "skills", "attention"))).toBe(
      join("..", "..", ".agents", "skills", "attention"),
    );

    expect(upsertWhitepaperFile(tmp)).toBe("created");
    expect(upsertWhitepaperFile(tmp)).toBe("unchanged");
    rmSync(join(tmp, "WHITEPAPER.md"));
    writeFileSync(join(tmp, "WHITEPAPER.md"), "manual copy");
    expect(upsertWhitepaperFile(tmp)).toBe("skipped");
    rmSync(join(tmp, "WHITEPAPER.md"));
    symlinkSync("old-target", join(tmp, "WHITEPAPER.md"));
    expect(upsertWhitepaperFile(tmp)).toBe("updated");
  });
});
