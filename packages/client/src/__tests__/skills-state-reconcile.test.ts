// Integration test for the state-based skill cleanup wiring inside
// `installFirstTreeSkills`. The current TREE tier is empty because all shipped
// First Tree skills install through CORE, but this historical reconcile ledger
// still removes names the CLI previously recorded and that are no longer in
// either current tier. Anything the user added under either location is
// path-precision-protected (the reconcile only touches names from the recorded
// set).
//
// Helper-level coverage of the installer copy logic lives in
// `bootstrap.test.ts`; this file proves the reconcile wiring in PR #869.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFirstTreeSkills, TREE_SKILL_NAMES } from "../runtime/first-tree-skills/installer.js";
import { MANAGED_STATE_REL, readManagedState, writeManagedState } from "../runtime/managed-state.js";

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
    expect(readManagedState(workspace)?.skills).toEqual([...TREE_SKILL_NAMES].sort());
  });

  it("keeps CORE skills a prior version recorded as TREE skills — moved tiers, not retired", () => {
    // Older versions recorded read/write/seed through the TREE ledger. All
    // shipped First Tree skills now install through CORE, so the TREE reconcile
    // must not delete those payloads when rolling the ledger forward to empty.
    for (const name of ["first-tree-seed", "first-tree-read", "first-tree-write"]) plantManagedSkill(workspace, name);
    writeManagedState(workspace, {
      schemaVersion: 1,
      cliVersion: "pre-core-move",
      updatedAt: new Date(0).toISOString(),
      skills: ["first-tree-write", "first-tree-read", "first-tree-seed"], // old TREE set
    });

    installFirstTreeSkills({ workspacePath: workspace, bundledSkillsRoot });

    for (const name of ["first-tree-seed", "first-tree-read", "first-tree-write"]) {
      expect(existsSync(join(workspace, ".agents", "skills", name, "SKILL.md"))).toBe(true);
      expect(lstatSync(join(workspace, ".claude", "skills", name)).isSymbolicLink()).toBe(true);
    }
    // The ledger still rolls forward to the TREE set only; CORE skills are
    // tracked via RETIRED_CORE_SKILL_NAMES, not this reconcile.
    expect(readManagedState(workspace)?.skills).toEqual([...TREE_SKILL_NAMES].sort());
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

  it("never deletes outside the skills roots for hostile names in prev state (#1610)", () => {
    // Sentinel OUTSIDE the workspace, reachable only through a traversal
    // name: `join(workspace, ".agents/skills", "../../../outside-payload")`
    // would normalize to `<tmpBase>/outside-payload` without validation.
    const outsidePayload = join(tmpBase, "outside-payload");
    mkdirSync(outsidePayload, { recursive: true });
    writeFileSync(join(outsidePayload, "sentinel.txt"), "do not delete");

    // A legitimate stale skill the reconcile must still remove.
    plantManagedSkill(workspace, "legacy-foo");
    writeManagedState(workspace, {
      schemaVersion: 1,
      cliVersion: "test",
      updatedAt: new Date(0).toISOString(),
      skills: [
        ...TREE_SKILL_NAMES,
        "legacy-foo",
        "../../../outside-payload",
        "../..", // resolves to the workspace root itself
        "..", // resolves to `.agents/` / `.claude/`
        ".", // the skills root itself
        "",
        "/etc",
      ],
    });

    installFirstTreeSkills({ workspacePath: workspace, bundledSkillsRoot });

    // Traversal targets outside the skills roots are untouched …
    expect(readFileSync(join(outsidePayload, "sentinel.txt"), "utf-8")).toBe("do not delete");
    // … the workspace itself survived "../.." …
    expect(existsSync(join(workspace, MANAGED_STATE_REL))).toBe(true);
    // … the skills roots survived ".." and "." …
    expect(existsSync(join(workspace, ".agents", "skills"))).toBe(true);
    expect(existsSync(join(workspace, ".claude", "skills"))).toBe(true);
    // … and the legitimate stale skill was still removed.
    expect(existsSync(join(workspace, ".agents", "skills", "legacy-foo"))).toBe(false);
    expect(() => lstatSync(join(workspace, ".claude", "skills", "legacy-foo"))).toThrow();
    // State rolls forward to the current bundle set as usual.
    expect(readManagedState(workspace)?.skills).toEqual([...TREE_SKILL_NAMES].sort());
  });
});
