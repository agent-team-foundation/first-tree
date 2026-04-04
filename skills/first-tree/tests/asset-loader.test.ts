import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_INSTALLED_PROGRESS,
  FRAMEWORK_VERSION,
  INSTALLED_PROGRESS,
  LEGACY_REPO_SKILL_PROGRESS,
  LEGACY_REPO_SKILL_VERSION,
  LEGACY_SKILL_PROGRESS,
  LEGACY_SKILL_VERSION,
  LEGACY_PROGRESS,
  LEGACY_VERSION,
  detectFrameworkLayout,
  frameworkVersionCandidates,
  progressFileCandidates,
  resolveFirstExistingPath,
} from "#skill/engine/runtime/asset-loader.js";
import { useTmpDir } from "./helpers.js";

describe("asset-loader", () => {
  it("prefers the installed skill layout when both layouts exist", () => {
    const tmp = useTmpDir();
    mkdirSync(join(tmp.path, ".agents", "skills", "first-tree", "assets", "framework"), {
      recursive: true,
    });
    mkdirSync(join(tmp.path, ".context-tree"), { recursive: true });
    writeFileSync(join(tmp.path, FRAMEWORK_VERSION), "0.2.0\n");
    writeFileSync(join(tmp.path, LEGACY_VERSION), "0.1.0\n");

    expect(detectFrameworkLayout(tmp.path)).toBe("skill");
    expect(resolveFirstExistingPath(tmp.path, [FRAMEWORK_VERSION, LEGACY_VERSION])).toBe(
      FRAMEWORK_VERSION,
    );
  });

  it("falls back to the legacy layout when the skill is not installed", () => {
    const tmp = useTmpDir();
    mkdirSync(join(tmp.path, ".context-tree"), { recursive: true });
    writeFileSync(join(tmp.path, LEGACY_VERSION), "0.1.0\n");

    expect(detectFrameworkLayout(tmp.path)).toBe("legacy");
  });

  it("detects the previous workspace skill path before older layouts", () => {
    const tmp = useTmpDir();
    mkdirSync(join(tmp.path, "skills", "first-tree", "assets", "framework"), {
      recursive: true,
    });
    mkdirSync(join(tmp.path, ".context-tree"), { recursive: true });
    writeFileSync(join(tmp.path, LEGACY_REPO_SKILL_VERSION), "0.2.0\n");
    writeFileSync(join(tmp.path, LEGACY_VERSION), "0.1.0\n");

    expect(detectFrameworkLayout(tmp.path)).toBe("legacy-repo-skill");
    expect(
      resolveFirstExistingPath(tmp.path, frameworkVersionCandidates()),
    ).toBe(LEGACY_REPO_SKILL_VERSION);
  });

  it("detects the previous installed skill name before the .context-tree layout", () => {
    const tmp = useTmpDir();
    mkdirSync(
      join(tmp.path, "skills", "first-tree-cli-framework", "assets", "framework"),
      {
        recursive: true,
      },
    );
    mkdirSync(join(tmp.path, ".context-tree"), { recursive: true });
    writeFileSync(join(tmp.path, LEGACY_SKILL_VERSION), "0.2.0\n");
    writeFileSync(join(tmp.path, LEGACY_VERSION), "0.1.0\n");

    expect(detectFrameworkLayout(tmp.path)).toBe("legacy-skill");
    expect(
      resolveFirstExistingPath(tmp.path, frameworkVersionCandidates()),
    ).toBe(LEGACY_SKILL_VERSION);
  });

  it("prefers the installed progress file candidate", () => {
    const tmp = useTmpDir();
    mkdirSync(join(tmp.path, ".agents", "skills", "first-tree"), { recursive: true });
    mkdirSync(join(tmp.path, ".claude", "skills", "first-tree"), { recursive: true });
    mkdirSync(join(tmp.path, "skills", "first-tree"), { recursive: true });
    mkdirSync(join(tmp.path, "skills", "first-tree-cli-framework"), {
      recursive: true,
    });
    mkdirSync(join(tmp.path, ".context-tree"), { recursive: true });
    writeFileSync(join(tmp.path, INSTALLED_PROGRESS), "new");
    writeFileSync(join(tmp.path, CLAUDE_INSTALLED_PROGRESS), "claude");
    writeFileSync(join(tmp.path, LEGACY_REPO_SKILL_PROGRESS), "old-repo-skill");
    writeFileSync(join(tmp.path, LEGACY_SKILL_PROGRESS), "old-skill");
    writeFileSync(join(tmp.path, LEGACY_PROGRESS), "old");

    expect(resolveFirstExistingPath(tmp.path, progressFileCandidates())).toBe(
      INSTALLED_PROGRESS,
    );
  });
});
