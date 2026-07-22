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
    expect(skill).toContain("The configured review agent may\nrepair the PR directly");
    expect(skill).toContain("Do not add a repair-consent block, exact-file permission\nlist");
    expect(skill).toContain("Do not add a repair-consent block");
    expect(skill).toContain("legacy dispatch marker or task payload");
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
    expect(skill).toContain("BYO clean (GitHub-bound Context Trees only)");
    expect(skill).toContain("A GitLab-bound tree\ncannot use this activation");
    expect(skill).toContain('first-tree --json tree write --team "<team-id>"');
    expect(skill).toContain('--snapshot "<exact-snapshot>" --github-login "<gh-login>"');
    expect(skill).toContain("Do not require or reconstruct a Workspace manifest");
    expect(skill).toContain("separate task worktree and branch from the returned exact base commit");
    expect(skill).toContain("immediately before the first push");
    expect(skill).toContain("observability only, never local routing");
  });

  it("selects publication forge from the Context Tree and follows ordinary GitLab MRs", () => {
    expect(skill).toMatch(/detect the Context Tree forge from its own `origin`/u);
    expect(skill).toContain("never infer it\nfrom the source");
    expect(skill).toMatch(/Audit-originated GitLab MR stays draft for ordinary independent review/u);
    expect(skill).toContain("first-tree gitlab follow <mr-url>");
    expect(skill).toContain("creating, resolving or\n   reusing any GitLab MR");
    expect(skill).toContain("returned pending or active state is success");
    expect(skill).toContain("failure does not invalidate the\n   MR");
  });

  it("keeps version metadata and the standalone VERSION file aligned", () => {
    const version = readFileSync(join(skillPath, "VERSION"), "utf8").trim();
    expect(version).toBe("0.12.0");
    expect(skill).toContain(`version: ${version}`);
    expect(skill.split("\n").length).toBeLessThanOrEqual(500);
  });
});
