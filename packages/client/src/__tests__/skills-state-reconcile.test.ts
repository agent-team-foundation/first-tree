// Integration test for the state-based skill cleanup wiring inside
// `installFirstTreeSkills`. Verifies that a skill the CLI previously
// installed (recorded in `.agent/managed.json::skills`) but that's no
// longer in the bundled `TREE_SKILL_NAMES` gets its `.agents/skills/<name>/`
// payload AND its `.claude/skills/<name>` symlink removed. Anything the
// user added under either location is path-precision-protected (the
// reconcile only touches names from the recorded set).
//
// Helper-level coverage of the installer copy logic lives in
// `bootstrap.test.ts`; this file proves the reconcile wiring in PR #869.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CORE_SKILL_NAMES, installFirstTreeSkills, TREE_SKILL_NAMES } from "../runtime/first-tree-skills/installer.js";
import { readManagedState, writeManagedState } from "../runtime/managed-state.js";

/**
 * Build a bundled-skills root mirroring the shape `installFirstTreeSkills`
 * expects: `<root>/<name>/SKILL.md`. Only ships the current `TREE_SKILL_NAMES`
 * so the reconcile-on-removal path has work to do (anything in prev state
 * not in `TREE_SKILL_NAMES` is "dropped").
 */
function makeBundledSkillsRoot(parent: string): string {
  const root = join(parent, "bundled-skills");
  mkdirSync(root, { recursive: true });
  for (const name of TREE_SKILL_NAMES) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\nfixture content for ${name}\n`);
  }
  return root;
}

function plantManagedSkill(workspace: string, name: string): void {
  // Real payload — installFirstTreeSkills's reconcile removes the dir.
  const agentsDir = join(workspace, ".agents", "skills", name);
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, "SKILL.md"), `---\nname: ${name}\n---\nstale ${name}\n`);
  // Matching `.claude/skills/<name>` symlink (the canonical layout).
  const claudeLink = join(workspace, ".claude", "skills", name);
  mkdirSync(join(workspace, ".claude", "skills"), { recursive: true });
  symlinkSync(join("..", "..", ".agents", "skills", name), claudeLink);
}

describe("installFirstTreeSkills — state-based skill reconcile (PR #869 P1-3)", () => {
  let tmpBase: string;
  let workspace: string;
  let bundledSkillsRoot: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "skill-reconcile-"));
    workspace = join(tmpBase, "ws");
    mkdirSync(join(workspace, ".first-tree-workspace"), { recursive: true });
    bundledSkillsRoot = makeBundledSkillsRoot(tmpBase);
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("removes `.agents/skills/<dropped>/` AND `.claude/skills/<dropped>` for skills no longer in TREE_SKILL_NAMES", () => {
    // Prev managed state lists current skills + two "retired" ones; the
    // current `TREE_SKILL_NAMES` (read from the bundle) does not include
    // `legacy-foo` / `legacy-bar`.
    plantManagedSkill(workspace, "legacy-foo");
    plantManagedSkill(workspace, "legacy-bar");
    writeManagedState(workspace, {
      schemaVersion: 1,
      cliVersion: "test",
      updatedAt: new Date(0).toISOString(),
      skills: [...TREE_SKILL_NAMES, "legacy-foo", "legacy-bar"],
    });

    installFirstTreeSkills({ workspacePath: workspace, bundledSkillsRoot });

    // Dropped skills are gone — both the payload directory and the
    // Claude-side symlink were removed.
    expect(existsSync(join(workspace, ".agents", "skills", "legacy-foo"))).toBe(false);
    expect(existsSync(join(workspace, ".agents", "skills", "legacy-bar"))).toBe(false);
    expect(() => lstatSync(join(workspace, ".claude", "skills", "legacy-foo"))).toThrow();
    expect(() => lstatSync(join(workspace, ".claude", "skills", "legacy-bar"))).toThrow();

    // Current skills are still present.
    for (const name of TREE_SKILL_NAMES) {
      expect(existsSync(join(workspace, ".agents", "skills", name, "SKILL.md"))).toBe(true);
      expect(lstatSync(join(workspace, ".claude", "skills", name)).isSymbolicLink()).toBe(true);
    }

    // State rolls forward to the current bundle set, sorted.
    const state = readManagedState(workspace);
    expect(state?.skills).toEqual([...TREE_SKILL_NAMES].sort());
  });

  it("removes retired First Tree skill payloads from previous managed state", () => {
    const retired = ["first-tree", "first-tree-context", "first-tree-sync", "first-tree-github"];
    for (const name of retired) plantManagedSkill(workspace, name);
    writeManagedState(workspace, {
      schemaVersion: 1,
      cliVersion: "test",
      updatedAt: new Date(0).toISOString(),
      skills: [...TREE_SKILL_NAMES, ...retired],
    });

    installFirstTreeSkills({ workspacePath: workspace, bundledSkillsRoot });

    for (const name of retired) {
      expect(existsSync(join(workspace, ".agents", "skills", name))).toBe(false);
      expect(() => lstatSync(join(workspace, ".claude", "skills", name))).toThrow();
    }
    // A current tree skill survives the reconcile (first-tree-read is the sole
    // TREE_SKILL_NAMES member; seed/write are core, covered separately below).
    expect(existsSync(join(workspace, ".agents", "skills", "first-tree-read", "SKILL.md"))).toBe(true);
    expect(lstatSync(join(workspace, ".claude", "skills", "first-tree-read")).isSymbolicLink()).toBe(true);
    expect(readManagedState(workspace)?.skills).toEqual([...TREE_SKILL_NAMES].sort());
  });

  it("does NOT remove a core skill listed in prev state but absent from TREE_SKILL_NAMES", () => {
    // Regression for the seed/write → core promotion. A previously tree-bound
    // agent's managed.json still lists first-tree-seed / first-tree-write under
    // the old TREE tier. installCoreSkills installs them first; the tree
    // reconcile MUST NOT delete them just because they left TREE_SKILL_NAMES.
    for (const name of CORE_SKILL_NAMES) plantManagedSkill(workspace, name);
    writeManagedState(workspace, {
      schemaVersion: 1,
      cliVersion: "test",
      updatedAt: new Date(0).toISOString(),
      skills: [...TREE_SKILL_NAMES, ...CORE_SKILL_NAMES],
    });

    installFirstTreeSkills({ workspacePath: workspace, bundledSkillsRoot });

    for (const name of CORE_SKILL_NAMES) {
      expect(existsSync(join(workspace, ".agents", "skills", name, "SKILL.md")), `${name} must survive`).toBe(true);
      expect(lstatSync(join(workspace, ".claude", "skills", name)).isSymbolicLink()).toBe(true);
    }
  });

  it("leaves a user-added skill alone — only names in the recorded prev state are removed", () => {
    // The CLI never recorded `my-custom` as installed, so even though
    // it's not in TREE_SKILL_NAMES the reconcile path must not touch it.
    plantManagedSkill(workspace, "my-custom");
    writeManagedState(workspace, {
      schemaVersion: 1,
      cliVersion: "test",
      updatedAt: new Date(0).toISOString(),
      skills: [...TREE_SKILL_NAMES], // does NOT include "my-custom"
    });

    installFirstTreeSkills({ workspacePath: workspace, bundledSkillsRoot });

    expect(existsSync(join(workspace, ".agents", "skills", "my-custom", "SKILL.md"))).toBe(true);
    expect(lstatSync(join(workspace, ".claude", "skills", "my-custom")).isSymbolicLink()).toBe(true);
  });

  it("first run (no managed.json) writes current bundle set without trying to remove anything", () => {
    installFirstTreeSkills({ workspacePath: workspace, bundledSkillsRoot });

    const state = readManagedState(workspace);
    expect(state?.skills).toEqual([...TREE_SKILL_NAMES].sort());
    for (const name of TREE_SKILL_NAMES) {
      expect(existsSync(join(workspace, ".agents", "skills", name, "SKILL.md"))).toBe(true);
    }
  });
});
