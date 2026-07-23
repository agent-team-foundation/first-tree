import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installFirstTreeSkills,
  installOneSkill,
  resolveBundledSkillsRoot,
  resolveWithinSkillsRoot,
  TREE_SKILL_NAMES,
} from "../runtime/first-tree-skills/installer.js";
import { writeManagedState } from "../runtime/managed-state.js";

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

function skillLayout(root: string, name = "first-tree-write") {
  return {
    name,
    sourceDir: join(root, name),
    agentsRelPath: join(".agents", "skills", name),
    claudeRelPath: join(".claude", "skills", name),
    claudeSymlinkTarget: join("..", "..", ".agents", "skills", name),
  };
}

function writeSkill(root: string, name = "first-tree-write", version?: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\nfixture for ${name}\n`);
  if (version !== undefined) writeFileSync(join(dir, "VERSION"), version);
}

function writeTreeSkillsRoot(parent: string): string {
  const root = join(parent, "bundled-skills");
  for (const name of TREE_SKILL_NAMES) writeSkill(root, name, "1.0.0");
  return root;
}

function plantManagedSkill(workspace: string, name: string, claudeShape: "directory" | "symlink" = "symlink"): void {
  const agentsDir = join(workspace, ".agents", "skills", name);
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, "SKILL.md"), `stale ${name}\n`);
  const claudePath = join(workspace, ".claude", "skills", name);
  mkdirSync(join(workspace, ".claude", "skills"), { recursive: true });
  if (claudeShape === "directory") {
    mkdirSync(claudePath, { recursive: true });
    writeFileSync(join(claudePath, "SKILL.md"), `stale claude ${name}\n`);
  } else {
    symlinkSync(join("..", "..", ".agents", "skills", name), claudePath);
  }
}

describe("first-tree skill installer edge coverage", () => {
  let tmpBase: string;
  let workspace: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "ft-skill-installer-"));
    workspace = join(tmpBase, "workspace");
    mkdirSync(workspace, { recursive: true });
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    vi.doUnmock("node:fs");
    vi.resetModules();
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("reports a packaging error when bundled skills cannot be found", () => {
    expect(() => resolveBundledSkillsRoot(join(tmpBase, "empty"))).toThrow(
      "Could not locate bundled `skills/` payloads",
    );
  });

  it("uses the package bundled root when installing tree skills without a test override", () => {
    const result = installFirstTreeSkills({ workspacePath: workspace });

    expect(result.ok).toBe(true);
    for (const name of TREE_SKILL_NAMES) {
      expect(existsSync(join(workspace, ".agents", "skills", name, "SKILL.md"))).toBe(true);
      expect(lstatSync(join(workspace, ".claude", "skills", name)).isSymbolicLink()).toBe(true);
    }
  });

  it("repairs a stale Claude directory companion without recopying matching agent payloads", () => {
    const bundledRoot = join(tmpBase, "bundled");
    writeSkill(bundledRoot, "first-tree-write", "1.0.0");
    const layout = skillLayout(bundledRoot);
    expect(installOneSkill(workspace, layout)).toBe("installed");
    writeFileSync(join(workspace, ".agents", "skills", "first-tree-write", ".sentinel"), "keep\n");
    rmSync(join(workspace, ".claude", "skills", "first-tree-write"), { recursive: true, force: true });
    mkdirSync(join(workspace, ".claude", "skills", "first-tree-write"), { recursive: true });

    expect(installOneSkill(workspace, layout)).toBe("skipped");

    expect(readlinkSync(join(workspace, ".claude", "skills", "first-tree-write"))).toBe(
      join("..", "..", ".agents", "skills", "first-tree-write"),
    );
    expect(existsSync(join(workspace, ".agents", "skills", "first-tree-write", ".sentinel"))).toBe(true);
  });

  it("reinstalls when installed VERSION cannot be read", () => {
    const bundledRoot = join(tmpBase, "bundled-version-read");
    writeSkill(bundledRoot, "first-tree-write", "1.0.0");
    const layout = skillLayout(bundledRoot);
    expect(installOneSkill(workspace, layout)).toBe("installed");
    rmSync(join(workspace, ".agents", "skills", "first-tree-write", "VERSION"), { force: true });
    mkdirSync(join(workspace, ".agents", "skills", "first-tree-write", "VERSION"));
    writeFileSync(join(workspace, ".agents", "skills", "first-tree-write", ".sentinel"), "remove\n");

    expect(installOneSkill(workspace, layout)).toBe("installed");

    expect(existsSync(join(workspace, ".agents", "skills", "first-tree-write", ".sentinel"))).toBe(false);
    expect(readFileSync(join(workspace, ".agents", "skills", "first-tree-write", "VERSION"), "utf8")).toBe("1.0.0");
  });

  it("reinstalls when installed SKILL.md cannot be read despite a matching VERSION", () => {
    const bundledRoot = join(tmpBase, "bundled-skill-read");
    writeSkill(bundledRoot, "first-tree-write", "1.0.0");
    const layout = skillLayout(bundledRoot);
    expect(installOneSkill(workspace, layout)).toBe("installed");
    rmSync(join(workspace, ".agents", "skills", "first-tree-write", "SKILL.md"), { force: true });
    mkdirSync(join(workspace, ".agents", "skills", "first-tree-write", "SKILL.md"));
    writeFileSync(join(workspace, ".agents", "skills", "first-tree-write", ".sentinel"), "remove\n");

    expect(installOneSkill(workspace, layout)).toBe("installed");

    expect(existsSync(join(workspace, ".agents", "skills", "first-tree-write", ".sentinel"))).toBe(false);
    expect(readFileSync(join(workspace, ".agents", "skills", "first-tree-write", "SKILL.md"), "utf8")).toContain(
      "fixture for first-tree-write",
    );
  });

  it("removes retired managed skills whose Claude companion is a directory", () => {
    const bundledSkillsRoot = writeTreeSkillsRoot(tmpBase);
    plantManagedSkill(workspace, "legacy-directory", "directory");
    writeManagedState(workspace, {
      schemaVersion: 1,
      cliVersion: "test",
      updatedAt: new Date(0).toISOString(),
      skills: [...TREE_SKILL_NAMES, "legacy-directory"],
    });

    const result = installFirstTreeSkills({ workspacePath: workspace, bundledSkillsRoot });

    expect(result.ok).toBe(true);
    expect(existsSync(join(workspace, ".agents", "skills", "legacy-directory"))).toBe(false);
    expect(existsSync(join(workspace, ".claude", "skills", "legacy-directory"))).toBe(false);
  });

  it("throws non-Windows symlink failures after cleaning the temp symlink path", async () => {
    const bundledRoot = join(tmpBase, "bundled-non-windows-symlink-error");
    writeSkill(bundledRoot, "first-tree-write", "1.0.0");
    setPlatform("linux");
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        symlinkSync: () => {
          throw Object.assign(new Error("symlink denied"), { code: "EIO" });
        },
      };
    });
    const mod = await import("../runtime/first-tree-skills/installer.js");

    expect(() => mod.installOneSkill(workspace, skillLayout(bundledRoot))).toThrow("symlink denied");
  });

  it("keeps a current Windows directory fallback after the agent payload is refreshed", async () => {
    const bundledRoot = join(tmpBase, "bundled-windows-directory-current");
    writeSkill(bundledRoot, "first-tree-write", "1.0.0");
    setPlatform("win32");
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        symlinkSync: () => {
          throw Object.assign(new Error("symlink denied"), { code: "EPERM" });
        },
      };
    });
    const mod = await import("../runtime/first-tree-skills/installer.js");

    expect(mod.installOneSkill(workspace, skillLayout(bundledRoot))).toBe("installed");
    writeFileSync(join(bundledRoot, "first-tree-write", "VERSION"), "2.0.0");
    writeFileSync(join(workspace, ".claude", "skills", "first-tree-write", "VERSION"), "2.0.0");
    writeFileSync(join(workspace, ".claude", "skills", "first-tree-write", ".sentinel"), "keep\n");
    expect(mod.installOneSkill(workspace, skillLayout(bundledRoot))).toBe("installed");

    expect(existsSync(join(workspace, ".claude", "skills", "first-tree-write", ".sentinel"))).toBe(true);
  });
});

describe("resolveWithinSkillsRoot", () => {
  it("returns the resolved target for a name inside the root", () => {
    expect(resolveWithinSkillsRoot(join("tmp", "skills-root"), "first-tree-write")).toBe(
      resolve("tmp", "skills-root", "first-tree-write"),
    );
  });

  it("refuses targets equal to the root or escaping it (#1610)", () => {
    const root = join("tmp", "skills-root");
    expect(resolveWithinSkillsRoot(root, ".")).toBeNull();
    expect(resolveWithinSkillsRoot(root, "")).toBeNull();
    expect(resolveWithinSkillsRoot(root, "..")).toBeNull();
    expect(resolveWithinSkillsRoot(root, "../sibling")).toBeNull();
    expect(resolveWithinSkillsRoot(root, "../../outside")).toBeNull();
    expect(resolveWithinSkillsRoot(root, "/abs/path")).toBeNull();
  });
});
