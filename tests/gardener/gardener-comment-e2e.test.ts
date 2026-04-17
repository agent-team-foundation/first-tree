import { describe, expect, it } from "vitest";
import { buildCommentBody } from "../../src/products/gardener/engine/comment.js";

describe("E2E: gardener comment body rendering (from PR #157 fixes)", () => {
  it("Fix #1: tree_repo absent → plain inline code (no broken /blob/main links)", () => {
    const body = buildCommentBody({
      verdict: "INSUFFICIENT_CONTEXT",
      severity: "low",
      summary: "No classifier was injected.",
      treeNodes: [
        { path: "engineering/auth/NODE.md", summary: "Auth architecture" },
        { path: "security/secrets.md", summary: "Secret handling" },
      ],
      reviewedShort: "abc12345",
      reviewedFull: "abc1234567890abc1234567890abc1234567890a",
      treeSha: "deadbeefcafebabe",
      treeShaShort: "deadbeef",
      itemType: "pr",
      // treeRepoUrl omitted
    });

    console.log("\n=== Fix #1: tree_repo ABSENT ===\n" + body + "\n===\n");

    // Plain inline-code rendering, no broken links.
    expect(body).toContain("- `engineering/auth/NODE.md` — Auth architecture");
    expect(body).toContain("- `security/secrets.md` — Secret handling");
    expect(body).not.toMatch(/\]\(\/blob\/main\//); // no broken relative link
    expect(body).not.toMatch(/\]\(undefined\//); // no literal undefined
    // Header + marker + verdict should still be present.
    expect(body).toContain("<!-- gardener:state ");
    expect(body).toContain("verdict=INSUFFICIENT_CONTEXT");
  });

  it("Fix #1 baseline: tree_repo present → clickable links", () => {
    const body = buildCommentBody({
      verdict: "INSUFFICIENT_CONTEXT",
      severity: "low",
      summary: "No classifier was injected.",
      treeNodes: [
        { path: "engineering/auth/NODE.md", summary: "Auth architecture" },
      ],
      reviewedShort: "abc12345",
      reviewedFull: "abc1234567890abc1234567890abc1234567890a",
      treeSha: "deadbeefcafebabe",
      treeShaShort: "deadbeef",
      itemType: "pr",
      treeRepoUrl: "https://github.com/example-org/example-tree",
      treeSlug: "example-org/example-tree",
    });

    console.log("\n=== Fix #1 baseline: tree_repo PRESENT ===\n" + body + "\n===\n");

    expect(body).toContain(
      "- [`engineering/auth/NODE.md`](https://github.com/example-org/example-tree/blob/main/engineering/auth/NODE.md)",
    );
  });

  it("Fix #1 edge: empty treeNodes list shows explanatory bullet", () => {
    const body = buildCommentBody({
      verdict: "NEW_TERRITORY",
      severity: "medium",
      summary: "This area isn't yet captured on the tree.",
      treeNodes: [],
      reviewedShort: "abc12345",
      reviewedFull: "abc1234567890abc1234567890abc1234567890a",
      treeSha: "deadbeefcafebabe",
      treeShaShort: "deadbeef",
      itemType: "pr",
    });
    expect(body).toContain("_(no tree nodes cited");
  });
});
