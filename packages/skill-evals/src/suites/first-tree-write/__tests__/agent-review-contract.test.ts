import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "../../../../../..");
const skillPath = join(repoRoot, "skills", "first-tree-write");
const skill = readFileSync(join(skillPath, "SKILL.md"), "utf8");

describe("first-tree-write Agent Review contract floor", () => {
  it("keeps the minimal managed PR, packet, and member keyed dispatch contract", () => {
    expect(skill).toContain("<!-- first-tree-context-review:managed-v1 -->");
    expect(skill).toContain('"taskType": "context_tree_pr_review"');
    expect(skill).toContain('"reviewPacketV1"');
    expect(skill).toContain("first-tree chat create --as-member [--org <org-id>]");
    expect(skill).toContain("--format markdown");
    expect(skill).toContain("--metadata-file <packet-file>");
    expect(skill).toContain("Serialized metadata must be at");
    expect(skill).toContain("most 32 KiB, depth at most 64, and structural nodes at most 8192");
    expect(skill).toContain("current-state semantics");
    expect(skill).toContain("Team + task type + canonical bound");
    expect(skill).toContain("Reassigning A to B keeps the same PR task and Chat");
    expect(skill).toContain("takeover addressed only to B");
  });

  it("does not restore removed authority or caller-routing mechanisms", () => {
    for (const retired of [
      "lite_v1",
      "authorityRevision",
      "--to-id",
      "--task-key",
      "workflow = agent_review",
      "governance",
      "mergeMethod",
      "Task identity is PR plus the current Reviewer assignment",
      "Reassigning A to B creates B's task",
    ]) {
      expect(skill).not.toContain(retired);
    }
  });

  it("keeps version metadata and the standalone VERSION file aligned", () => {
    const version = readFileSync(join(skillPath, "VERSION"), "utf8").trim();
    expect(version).toBe("0.10.0");
    expect(skill).toContain(`version: ${version}`);
    expect(skill.split("\n").length).toBeLessThanOrEqual(500);
  });
});
