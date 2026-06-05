// Drift guard for the two hand-maintained skill lists that MUST stay in
// sync:
//
//   - `TREE_SKILL_NAMES` in `runtime/first-tree-skills/installer.ts`
//     — what the runtime installer copies into the agent workspace at
//     session start.
//
//   - `BUNDLED_SKILLS` in `scripts/copy-bundled-skills.mjs`
//     — what the prebuild script copies from repo-root `skills/` into the
//     client package's `skills/` directory.
//
// If they drift, one of two bad things happens on the next session bootstrap:
//
//   (a) installer asks for a skill the prebuild never copied →
//       installFirstTreeIntegration returns false; the skill is silently
//       missing from the workspace.
//
//   (b) prebuild copies a skill the installer never reads →
//       tarball is bigger than needed (cosmetic only, but a hint of an
//       unfinished change).
//
// Suggested by PR #844 review (R1 / Finding 1). Cheap to maintain:
// adding a skill is a one-line edit to each list + a one-line edit to
// repo-root `skills/`.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TREE_SKILL_NAMES } from "../runtime/first-tree-skills/installer.js";

const clientPackageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function extractBundledSkillsFromScript(): readonly string[] {
  const scriptPath = join(clientPackageRoot, "scripts", "copy-bundled-skills.mjs");
  const source = readFileSync(scriptPath, "utf-8");
  const match = source.match(/const\s+BUNDLED_SKILLS\s*=\s*\[([\s\S]*?)\]/u);
  if (!match) {
    throw new Error(`Could not locate BUNDLED_SKILLS array in ${scriptPath}`);
  }
  const body = match[1] ?? "";
  return body
    .split(",")
    .map((entry) => entry.trim().replace(/^["']|["']$/gu, ""))
    .filter((entry) => entry.length > 0);
}

describe("bundled skill list — runtime vs prebuild script", () => {
  it("TREE_SKILL_NAMES (installer) and BUNDLED_SKILLS (prebuild) carry exactly the same names", () => {
    const bundled = extractBundledSkillsFromScript();
    // Use a Set for the equality assertion so the diff vitest shows on
    // failure surfaces "missing in installer" vs "missing in script"
    // directly, rather than an order-sensitive array compare.
    expect(new Set(bundled)).toEqual(new Set(TREE_SKILL_NAMES));
  });
});
