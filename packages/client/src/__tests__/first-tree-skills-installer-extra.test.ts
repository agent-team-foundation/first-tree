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
  removeManagedSkill,
  resolveBundledSkillsRoot,
  resolveManagedSkillRemovalTarget,
  TREE_SKILL_NAMES,
} from "../runtime/first-tree-skills/installer.js";
import { readManagedState, writeManagedState } from "../runtime/managed-state.js";

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
    vi.doUnmock("../runtime/managed-state.js");
    vi.resetModules();
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("resolves only exact immediate children under each skills root", () => {
    const external = join(tmpBase, "external");
    const rejected = [
      "",
      ".",
      "..",
      "../skills-sibling",
      "../../external",
      "nested/skill",
      "nested\\skill",
      external,
      "C:",
      "C:relative",
      "C:\\absolute\\skill",
      "C:/absolute/skill",
      "\\root-relative\\skill",
      "\\\\server\\share\\skill",
      "\\\\?\\C:\\device\\skill",
      "\\\\.\\pipe\\skill",
    ];

    for (const root of [join(workspace, ".agents", "skills"), join(workspace, ".claude", "skills")]) {
      expect(resolveManagedSkillRemovalTarget(root, "legacy-safe")).toBe(resolve(root, "legacy-safe"));
      for (const name of rejected) {
        expect(
          resolveManagedSkillRemovalTarget(root, name),
          `${root} should reject ${JSON.stringify(name)}`,
        ).toBeNull();
      }
    }
  });

  it("wires every root through containment even when the slug guard is permissive", async () => {
    const agentsRoot = join(workspace, ".agents", "skills");
    const claudeRoot = join(workspace, ".claude", "skills");
    mkdirSync(agentsRoot, { recursive: true });
    mkdirSync(claudeRoot, { recursive: true });
    writeFileSync(join(agentsRoot, ".root-sentinel"), "keep agents root\n");
    writeFileSync(join(claudeRoot, ".root-sentinel"), "keep claude root\n");
    plantManagedSkill(workspace, "legacy-safe");

    const permissiveValidator = vi.fn(() => true);
    vi.resetModules();
    vi.doMock("../runtime/managed-state.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../runtime/managed-state.js")>();
      return {
        ...actual,
        isValidManagedSkillName: permissiveValidator,
      };
    });

    try {
      const mod = await import("../runtime/first-tree-skills/installer.js");
      mod.removeManagedSkill(workspace, ".");

      expect(permissiveValidator).toHaveBeenCalledTimes(2);
      expect(existsSync(agentsRoot)).toBe(true);
      expect(existsSync(claudeRoot)).toBe(true);
      expect(readFileSync(join(agentsRoot, ".root-sentinel"), "utf8")).toContain("keep agents root");
      expect(readFileSync(join(claudeRoot, ".root-sentinel"), "utf8")).toContain("keep claude root");

      mod.removeManagedSkill(workspace, "legacy-safe");

      expect(permissiveValidator).toHaveBeenCalledTimes(4);
      expect(existsSync(join(agentsRoot, "legacy-safe"))).toBe(false);
      expect(() => lstatSync(join(claudeRoot, "legacy-safe"))).toThrow();
    } finally {
      vi.doUnmock("../runtime/managed-state.js");
      vi.resetModules();
    }
  });

  it("continues reconciliation and rolls the ledger when the agents directory removal fails", async () => {
    plantManagedSkill(workspace, "legacy-failure");
    const agentsPath = join(workspace, ".agents", "skills", "legacy-failure");
    const claudePath = join(workspace, ".claude", "skills", "legacy-failure");
    writeManagedState(workspace, {
      schemaVersion: 1,
      cliVersion: "previous",
      updatedAt: new Date(0).toISOString(),
      skills: ["legacy-failure"],
    });

    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        rmSync: (path: string, options: { force?: boolean; recursive?: boolean }) => {
          if (path === agentsPath) {
            throw Object.assign(new Error("agents removal denied"), { code: "EACCES" });
          }
          return actual.rmSync(path, options);
        },
      };
    });

    try {
      const mod = await import("../runtime/first-tree-skills/installer.js");
      mod.installFirstTreeSkills({ workspacePath: workspace, bundledSkillsRoot: writeTreeSkillsRoot(tmpBase) });

      expect(existsSync(agentsPath)).toBe(true);
      expect(() => lstatSync(claudePath)).toThrow();
      expect(readManagedState(workspace)?.skills).toEqual([...TREE_SKILL_NAMES].sort());
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("unlinks stale leaf symlinks without following their external target", () => {
    const external = join(tmpBase, "external-leaf-target");
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "sentinel"), "keep external target\n");
    const agentsPath = join(workspace, ".agents", "skills", "legacy-link");
    const claudePath = join(workspace, ".claude", "skills", "legacy-link");
    mkdirSync(join(workspace, ".agents", "skills"), { recursive: true });
    mkdirSync(join(workspace, ".claude", "skills"), { recursive: true });
    symlinkSync(external, agentsPath);
    symlinkSync(external, claudePath);

    removeManagedSkill(workspace, "legacy-link");

    expect(() => lstatSync(agentsPath)).toThrow();
    expect(() => lstatSync(claudePath)).toThrow();
    expect(readFileSync(join(external, "sentinel"), "utf8")).toContain("keep external target");
  });

  it("removes a stale directory without following a nested external symlink", () => {
    const external = join(tmpBase, "external-nested-target");
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "sentinel"), "keep nested target\n");
    const agentsPath = join(workspace, ".agents", "skills", "legacy-nested");
    const claudePath = join(workspace, ".claude", "skills", "legacy-nested");
    mkdirSync(agentsPath, { recursive: true });
    symlinkSync(external, join(agentsPath, "external-link"));
    mkdirSync(join(workspace, ".claude", "skills"), { recursive: true });
    symlinkSync(join("..", "..", ".agents", "skills", "legacy-nested"), claudePath);

    removeManagedSkill(workspace, "legacy-nested");

    expect(existsSync(agentsPath)).toBe(false);
    expect(() => lstatSync(claudePath)).toThrow();
    expect(readFileSync(join(external, "sentinel"), "utf8")).toContain("keep nested target");
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
