import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatProgressSummary,
  parseProgressMarkdown,
  summarizeProgressMarkdown,
} from "../../assets/tree/helpers/summarize-progress.js";
import { useTmpDir } from "../helpers.js";

const SAMPLE_PROGRESS = `# Context Tree Init

## Framework
- [x] Install the bundled skill

## Root Node
- [x] Fill in the root node

## Members
- [ ] Add at least one member node

## Populate Tree
- [ ] Launch wave-based domain population

## Verification
- [ ] Run first-tree tree verify
`;

describe("summarize-progress helper", () => {
  it("parses checklist groups and tasks from progress markdown", () => {
    const groups = parseProgressMarkdown(SAMPLE_PROGRESS);

    expect(groups.map((group) => group.group)).toEqual([
      "Framework",
      "Root Node",
      "Members",
      "Populate Tree",
      "Verification",
    ]);
    expect(groups[2]?.tasks[0]).toEqual({
      done: false,
      text: "Add at least one member node",
    });
  });

  it("summarizes integration, tree-content, and verification lanes", () => {
    const summary = summarizeProgressMarkdown(SAMPLE_PROGRESS);

    expect(summary.integration.completed).toBe(1);
    expect(summary.integration.total).toBe(1);
    expect(summary.treeContent.completed).toBe(1);
    expect(summary.treeContent.total).toBe(3);
    expect(summary.verification.completed).toBe(0);
    expect(summary.verification.total).toBe(1);
  });

  it("formats a human-readable onboarding checkpoint", () => {
    const summary = summarizeProgressMarkdown(SAMPLE_PROGRESS);
    const output = formatProgressSummary(summary);

    expect(output).toContain("Onboarding progress checkpoint");
    expect(output).toContain("Tree content baseline coverage: 1/3 tasks complete");
    expect(output).toContain("Remaining tree-content work:");
    expect(output).toContain("Members: Add at least one member node");
  });

  it("runs as a standalone helper script from the current repo", () => {
    const tmp = useTmpDir();
    const skillDir = join(tmp.path, ".agents", "skills", "first-tree");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "progress.md"), SAMPLE_PROGRESS);

    const output = execFileSync(
      "node",
      [
        join(
          process.cwd(),
          "assets",
          "tree",
          "helpers",
          "summarize-progress.js",
        ),
      ],
      {
        cwd: tmp.path,
        encoding: "utf-8",
        stdio: "pipe",
      },
    );

    expect(output).toContain("Setup and integration: 1/1 tasks complete");
    expect(output).toContain("Tree content baseline coverage: 1/3 tasks complete");
  });
});
