import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "../../../../../..");
const skillPath = join(repoRoot, "skills", "first-tree-write");
const skill = readFileSync(join(skillPath, "SKILL.md"), "utf8");

describe("first-tree-write App review handoff floor", () => {
  it("ends writer ownership at a source-complete provider artifact", () => {
    expect(skill).toContain("Let provider automation own review dispatch");
    expect(skill).toContain("GitHub App webhook creates or reuses the PR-scoped Reviewer Chat");
    expect(skill).toContain("valid matching inbound Webhook creates or\n   reuses the MR-scoped Reviewer Chat");
    expect(skill).toContain("The configured review agent may\nrepair the PR directly");
    expect(skill).toContain("Do not add a repair-consent block, exact-file permission\nlist");
    expect(skill).toContain("Do not add a repair-consent block");
    expect(skill).toContain("legacy dispatch marker or task payload");
    expect(skill).toContain("Supported GitHub App or GitLab inbound Webhooks are the sole dispatch");
  });

  it("does not retain the member task packet or direct Reviewer dispatch", () => {
    expect(skill).not.toContain('"taskType": "context_tree_pr_review"');
    expect(skill).not.toContain('"reviewPacketV1"');
    expect(skill).not.toContain("--metadata-file <packet-file>");
    expect(skill).not.toContain("same keyed handoff");
    expect(skill).not.toContain("Reassigning A to B keeps the same PR task and Chat");
  });

  it("keeps BYO Write bound to the SCOPE route and a new user confirmation", () => {
    expect(skill).toContain("exact snapshot and opaque route selection created by\n  `first-tree-read`");
    expect(skill).toContain("first-tree --json context write-preflight");
    expect(skill).toContain('--snapshot "<exact-snapshot>" --github-login "<gh-login>"');
    expect(skill).toContain("For GitLab, do not pass a GitHub login");
    expect(skill).toContain("exact-host\nGitLab `glab` authentication");
    expect(skill).toContain("Never accept or re-select a Team during\n  Write");
    expect(skill).toContain("Plan and ask in every BYO write");
    expect(skill).toContain("Before creating an authoring worktree");
    expect(skill).toContain("wait for a **new user reply** confirming that exact\n   plan");
    expect(skill).toContain("Initial write intent is not this confirmation");
    expect(skill).toContain("Managed mode does not add this gate");
    expect(skill).toContain("Only after the BYO confirmation above, create the\n   authoring worktree");
    expect(skill).toContain("re-run the same\npreflight immediately before each push and PR/MR creation");
    expect(skill).toContain("observability only, never local routing");
  });

  it("selects publication forge from the Context Tree and follows GitLab MRs", () => {
    expect(skill).toMatch(/detect the Context Tree forge from its own `origin`/u);
    expect(skill).toContain("never infer it\nfrom the source");
    expect(skill).toMatch(/Audit-originated artifacts stay draft/u);
    expect(skill).toContain("first-tree gitlab follow <mr-url>");
    expect(skill).toContain("creating, resolving or\n   reusing any GitLab MR");
    expect(skill).toContain("returned pending or active state is success");
    expect(skill).toContain("failure does not invalidate the\n   MR");
  });

  it("keeps version metadata and the standalone VERSION file aligned", () => {
    const version = readFileSync(join(skillPath, "VERSION"), "utf8").trim();
    expect(version).toBe("0.16.0");
    expect(skill).toContain(`version: ${version}`);
    expect(skill.split("\n").length).toBeLessThanOrEqual(500);
  });
});
