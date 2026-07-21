import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "../../../../../..");
const skillPath = join(repoRoot, "skills", "first-tree-write");
const skill = readFileSync(join(skillPath, "SKILL.md"), "utf8");

describe("first-tree-write App review handoff floor", () => {
  it("ends writer ownership at a source-complete GitHub PR", () => {
    expect(skill).toContain("Let the App reviewer own GitHub review dispatch");
    expect(skill).toContain("GitHub App webhook creates or\n   reuses the PR-scoped Reviewer Chat");
    expect(skill).toContain("keep the PR body human-readable");
    expect(skill).toContain("source artifact, durable decision summary and rationale");
    expect(skill).toContain("Do not add a repair-consent sentence");
    expect(skill).toContain("live\nbase-to-head changed files intersected with non-protected policy");
    expect(skill).not.toContain("### Repair scope");
    expect(skill).toContain("Every pushed\nsuccessor head must be reviewed from the beginning");
    expect(skill).toContain("Do not add a legacy\ndispatch marker; it has no behavior");
    expect(skill).toContain("Supported GitHub App webhooks are the sole dispatch owner");
  });

  it("does not retain the member task packet or direct Reviewer dispatch", () => {
    expect(skill).not.toContain('"taskType": "context_tree_pr_review"');
    expect(skill).not.toContain('"reviewPacketV1"');
    expect(skill).not.toContain("--metadata-file <packet-file>");
    expect(skill).not.toContain("same keyed handoff");
    expect(skill).not.toContain("Reassigning A to B keeps the same PR task and Chat");
  });

  it("keeps clean BYO Write bound to explicit Team and exact snapshot", () => {
    expect(skill).toContain('first-tree --json tree write --team "<team-id>"');
    expect(skill).toContain('--snapshot "<exact-snapshot>" --github-login "<gh-login>"');
    expect(skill).toContain("Do not require or reconstruct a Workspace manifest");
    expect(skill).toContain("separate task worktree and branch from the returned exact base commit");
    expect(skill).toContain("immediately before the first push");
    expect(skill).toContain("observability only, never local routing");
  });

  it("keeps version metadata and the standalone VERSION file aligned", () => {
    const version = readFileSync(join(skillPath, "VERSION"), "utf8").trim();
    expect(version).toBe("0.12.0");
    expect(skill).toContain(`version: ${version}`);
    expect(skill.split("\n").length).toBeLessThanOrEqual(500);
  });
});
