import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FRAMEWORK_VERSION,
  INSTALLED_PROGRESS,
  LEGACY_PROGRESS,
  LEGACY_VERSION,
  detectFrameworkLayout,
  progressFileCandidates,
  resolveFirstExistingPath,
} from "#skill/engine/runtime/asset-loader.js";
import { useTmpDir } from "./helpers.js";

describe("asset-loader", () => {
  it("prefers the installed skill layout when both layouts exist", () => {
    const tmp = useTmpDir();
    mkdirSync(join(tmp.path, "skills", "first-tree-cli-framework", "assets", "framework"), {
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

  it("prefers the installed progress file candidate", () => {
    const tmp = useTmpDir();
    mkdirSync(join(tmp.path, "skills", "first-tree-cli-framework"), { recursive: true });
    mkdirSync(join(tmp.path, ".context-tree"), { recursive: true });
    writeFileSync(join(tmp.path, INSTALLED_PROGRESS), "new");
    writeFileSync(join(tmp.path, LEGACY_PROGRESS), "old");

    expect(resolveFirstExistingPath(tmp.path, progressFileCandidates())).toBe(
      INSTALLED_PROGRESS,
    );
  });
});
