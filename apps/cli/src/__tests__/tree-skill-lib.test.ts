import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bundledSkillsRootFrom,
  collectSkillDiagnosis,
  collectSkillStatus,
  copyCoreSkills,
  inspectSkillEntry,
  readBundledSkillVersion,
  repairClaudeSkillLinks,
  resolveBundledSkillsRoot,
  SKILL_NAMES,
  type SkillName,
  upsertWhitepaperFile,
} from "../commands/tree/skill-lib.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ft-tree-skill-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function installSkill(
  name: SkillName,
  options: {
    cliCompat?: string;
    frontmatterVersion?: string;
    includeFrontmatter?: boolean;
    includeOpenAiConfig?: boolean;
    version?: string;
  } = {},
): string {
  const skillRoot = join(root, ".agents", "skills", name);
  mkdirSync(join(skillRoot, "agents"), { recursive: true });
  const version = options.version ?? "1.2.3";
  const includeFrontmatter = options.includeFrontmatter ?? true;
  const cliCompat = options.cliCompat ?? ">=0.0.0";
  const frontmatterVersion = options.frontmatterVersion ?? version;
  const frontmatter = includeFrontmatter
    ? `---\nname: ${name}\nversion: ${frontmatterVersion}\ncliCompat:\n  first-tree: "${cliCompat}"\n---\n`
    : "";

  writeFileSync(join(skillRoot, "SKILL.md"), `${frontmatter}# ${name}\n`);
  writeFileSync(join(skillRoot, "VERSION"), `${version}\n`);
  if (options.includeOpenAiConfig ?? true) {
    writeFileSync(join(skillRoot, "agents", "openai.yaml"), "name: test\n");
  }

  return skillRoot;
}

function linkClaudeSkill(name: SkillName, target = join("..", "..", ".agents", "skills", name)): void {
  const claudeRoot = join(root, ".claude", "skills");
  mkdirSync(claudeRoot, { recursive: true });
  symlinkSync(target, join(claudeRoot, name));
}

describe("tree skill library", () => {
  it("inspects missing entries, directories, and symlinks", () => {
    const directory = join(root, "skill-dir");
    const symlink = join(root, "skill-link");
    mkdirSync(directory);
    symlinkSync("skill-dir", symlink);

    expect(inspectSkillEntry(join(root, "missing"))).toEqual({ kind: "missing", target: null });
    expect(inspectSkillEntry(directory)).toEqual({ kind: "directory", target: null });
    expect(inspectSkillEntry(symlink)).toEqual({ kind: "symlink", target: "skill-dir" });
  });

  it("collects installed status with version and compatibility metadata", () => {
    installSkill("first-tree-github-scan", { cliCompat: ">=0.0.0 <999.0.0" });
    linkClaudeSkill("first-tree-github-scan");

    const rows = collectSkillStatus(root);
    const ghScan = rows.find((row) => row.name === "first-tree-github-scan");
    const firstTree = rows.find((row) => row.name === "first-tree");

    expect(rows).toHaveLength(SKILL_NAMES.length);
    expect(ghScan).toMatchObject({
      agentsKind: "directory",
      claudeKind: "symlink",
      cliCompat: ">=0.0.0 <999.0.0",
      compatible: true,
      installed: true,
      name: "first-tree-github-scan",
      version: "1.2.3",
    });
    expect(ghScan?.claudeTarget).toBe("../../.agents/skills/first-tree-github-scan");
    expect(firstTree).toMatchObject({
      installed: false,
      compatible: null,
      version: null,
    });
  });

  it("diagnoses missing files, bad frontmatter, bad symlinks, and incompatible CLI ranges", () => {
    installSkill("first-tree-github-scan", { includeOpenAiConfig: false });
    linkClaudeSkill("first-tree-github-scan", "wrong-target");

    installSkill("github-scan", { includeFrontmatter: false });
    linkClaudeSkill("github-scan");

    installSkill("first-tree-sync", { version: "2.0.0", frontmatterVersion: "3.0.0" });
    linkClaudeSkill("first-tree-sync");

    installSkill("first-tree-write", { cliCompat: ">999.0.0" });
    linkClaudeSkill("first-tree-write");

    installSkill("first-tree-onboarding", { cliCompat: "not-a-range" });
    linkClaudeSkill("first-tree-onboarding");

    const rows = collectSkillDiagnosis(root);
    const byName = new Map(rows.map((row) => [row.name, row]));

    expect(byName.get("first-tree-github-scan")?.problems).toEqual(
      expect.arrayContaining([
        ".agents/skills/first-tree-github-scan/agents/openai.yaml does not exist",
        ".claude/skills/first-tree-github-scan -> wrong-target, expected ../../.agents/skills/first-tree-github-scan",
      ]),
    );
    expect(byName.get("github-scan")?.problems).toEqual(
      expect.arrayContaining([
        ".agents/skills/github-scan/SKILL.md frontmatter is missing version",
        ".agents/skills/github-scan/SKILL.md frontmatter is missing cliCompat.first-tree",
      ]),
    );
    expect(byName.get("first-tree-sync")?.problems).toContain(
      ".agents/skills/first-tree-sync/SKILL.md version 3.0.0 does not match VERSION 2.0.0",
    );
    expect(byName.get("first-tree-write")?.incompatibleCliCompat).toBe(">999.0.0");
    expect(byName.get("first-tree-write")?.problems.join("\n")).toContain("requires first-tree >999.0.0");
    expect(byName.get("first-tree-onboarding")?.problems).toContain(
      "first-tree-onboarding has an unreadable cliCompat range: not-a-range",
    );
    expect(byName.get("first-tree")?.problems).toEqual(
      expect.arrayContaining(["missing: .agents/skills/first-tree", "missing: .claude/skills/first-tree"]),
    );
  });

  it("accepts a complete first-tree-context skill with reference files", () => {
    // Context Tree concept references migrated from `first-tree/` to
    // `first-tree-context/` in the skill-topology restructure (proposal:
    // skill-restructure.20260602). The top-level `first-tree` skill no
    // longer carries references — it is a routing/hygiene entry point.
    const skillRoot = installSkill("first-tree-context");
    for (const file of [
      join("references", "structure.md"),
      join("references", "functions.md"),
      join("references", "anti-patterns.md"),
      join("references", "maintenance.md"),
      join("references", "cli-manual.md"),
      join("references", "llms.txt"),
    ]) {
      mkdirSync(join(skillRoot, "references"), { recursive: true });
      writeFileSync(join(skillRoot, file), "content\n");
    }
    linkClaudeSkill("first-tree-context");

    const row = collectSkillDiagnosis(root).find((candidate) => candidate.name === "first-tree-context");
    expect(row).toMatchObject({ ok: true, problems: [] });
  });

  it("does not require references on the top-level first-tree skill", () => {
    const skillRoot = installSkill("first-tree");
    // Intentionally NO references/ subtree — first-tree is routing-only post-restructure.
    expect(existsSync(join(skillRoot, "references"))).toBe(false);
    linkClaudeSkill("first-tree");

    const row = collectSkillDiagnosis(root).find((candidate) => candidate.name === "first-tree");
    expect(row).toMatchObject({ ok: true, problems: [] });
  });

  it("repairs Claude skill links for installed agent skills and skips missing installs", () => {
    installSkill("first-tree-github-scan");
    installSkill("github-scan");
    mkdirSync(join(root, ".claude", "skills", "first-tree-github-scan"), { recursive: true });

    const result = repairClaudeSkillLinks(root);

    expect(result.linked).toBe(2);
    expect(result.skipped).toBe(SKILL_NAMES.length - 2);
    expect(result.messages).toEqual(
      expect.arrayContaining([
        "linked .claude/skills/first-tree-github-scan -> ../../.agents/skills/first-tree-github-scan",
        "linked .claude/skills/github-scan -> ../../.agents/skills/github-scan",
      ]),
    );
    expect(readlinkSync(join(root, ".claude", "skills", "first-tree-github-scan"))).toBe(
      "../../.agents/skills/first-tree-github-scan",
    );
    expect(readlinkSync(join(root, ".claude", "skills", "github-scan"))).toBe("../../.agents/skills/github-scan");
  });

  it("leaves already-correct Claude skill links unchanged", () => {
    installSkill("first-tree-github-scan");
    linkClaudeSkill("first-tree-github-scan");

    expect(repairClaudeSkillLinks(root)).toEqual({ linked: 0, skipped: SKILL_NAMES.length - 1, messages: [] });
  });

  it("manages the WHITEPAPER symlink without replacing user files or directories", () => {
    expect(upsertWhitepaperFile(root)).toBe("created");
    expect(readlinkSync(join(root, "WHITEPAPER.md"))).toBe(join(".agents", "skills", "first-tree", "SKILL.md"));
    expect(upsertWhitepaperFile(root)).toBe("unchanged");

    unlinkSync(join(root, "WHITEPAPER.md"));
    symlinkSync("old-target", join(root, "WHITEPAPER.md"));
    expect(upsertWhitepaperFile(root)).toBe("updated");
    expect(readlinkSync(join(root, "WHITEPAPER.md"))).toBe(join(".agents", "skills", "first-tree", "SKILL.md"));

    unlinkSync(join(root, "WHITEPAPER.md"));
    writeFileSync(join(root, "WHITEPAPER.md"), "custom\n");
    expect(upsertWhitepaperFile(root)).toBe("skipped");
    expect(readFileSync(join(root, "WHITEPAPER.md"), "utf8")).toBe("custom\n");

    unlinkSync(join(root, "WHITEPAPER.md"));
    mkdirSync(join(root, "WHITEPAPER.md"));
    expect(upsertWhitepaperFile(root)).toBe("skipped");
    expect(existsSync(join(root, "WHITEPAPER.md"))).toBe(true);
  });

  it("resolves bundled skills and copies only core skills", () => {
    const bundled = resolveBundledSkillsRoot();
    expect(bundledSkillsRootFrom(process.cwd())).toBe(bundled);
    expect(readBundledSkillVersion()).toMatch(/\d+\.\d+\.\d+/u);
    expect(() => bundledSkillsRootFrom(join(tmpdir(), "definitely-missing-first-tree-skills"))).toThrow(
      "Could not locate bundled `skills/` payloads",
    );

    const staleClaudeDir = join(root, ".claude", "skills", "attention");
    mkdirSync(staleClaudeDir, { recursive: true });
    writeFileSync(join(staleClaudeDir, "stale.txt"), "old\n");

    copyCoreSkills(root);

    expect(existsSync(join(root, ".agents", "skills", "attention", "SKILL.md"))).toBe(true);
    expect(readlinkSync(join(root, ".claude", "skills", "attention"))).toBe("../../.agents/skills/attention");
    expect(existsSync(join(root, ".agents", "skills", "first-tree"))).toBe(false);
  });

  it("handles unreadable metadata and missing CLI package versions", () => {
    const isolated = mkdtempSync(join(tmpdir(), "ft-tree-skill-no-package-"));
    try {
      installSkill("attention", { version: "" });
      linkClaudeSkill("attention");
      const skillRoot = join(root, ".agents", "skills", "first-tree-onboarding");
      mkdirSync(skillRoot, { recursive: true });
      writeFileSync(join(skillRoot, "SKILL.md"), '---\nversion: 1.0.0\ncliCompat:\n  first-tree: "=not-semver"\n---\n');
      writeFileSync(join(skillRoot, "VERSION"), "\n");
      linkClaudeSkill("first-tree-onboarding");

      expect(collectSkillStatus(root).find((row) => row.name === "attention")).toMatchObject({
        compatible: true,
        version: null,
      });
      expect(collectSkillDiagnosis(root).find((row) => row.name === "first-tree-onboarding")?.problems).toContain(
        "first-tree-onboarding has an unreadable cliCompat range: =not-semver",
      );

      writeFileSync(join(isolated, "package.json"), "{ invalid json");
      const localSkill = join(isolated, ".agents", "skills", "attention");
      mkdirSync(join(localSkill, "agents"), { recursive: true });
      writeFileSync(join(localSkill, "SKILL.md"), '---\nversion: 1.0.0\ncliCompat:\n  first-tree: ">0.0.0"\n---\n');
      writeFileSync(join(localSkill, "VERSION"), "1.0.0\n");
      writeFileSync(join(localSkill, "agents", "openai.yaml"), "name: test\n");
      mkdirSync(join(isolated, ".claude", "skills"), { recursive: true });
      symlinkSync(join("..", "..", ".agents", "skills", "attention"), join(isolated, ".claude", "skills", "attention"));
      expect(collectSkillStatus(isolated).find((row) => row.name === "attention")?.cliVersion).toBeTypeOf("string");
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});
