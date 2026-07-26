import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..", "..");

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

const dispositions = [
  "no-change",
  "candidate-new-case",
  "candidate-case-update",
  "move-to-product-test",
  "move-to-skill-eval",
  "merge-or-retire",
] as const;

describe("first-tree-qa lifecycle contract", () => {
  it("keeps the universal lifecycle in the skill and the First Tree extension in the package", () => {
    const skill = readRepoFile("skills/first-tree-qa/SKILL.md");
    const packageInstructions = readRepoFile("packages/qa/AGENTS.md");

    expect(packageInstructions).toContain("The skill owns the QA lifecycle");
    expect(packageInstructions).toContain("repository-specific requirements");
    expect(skill).toMatch(/`packages\/qa`\s+supplies\s+stricter run-cell rules/u);
    expect(skill).toContain("it extends this lifecycle instead of replacing it");

    const phases = [
      "### 1. Understand the product",
      "### 2. Reach `QA READY`",
      "### 3. Scope the task",
      "### 4. Execute and adapt",
      "### 5. Report and improve the quality system",
    ];
    let previous = -1;
    for (const phase of phases) {
      const current = skill.indexOf(phase);
      expect(current, `missing lifecycle phase: ${phase}`).toBeGreaterThan(previous);
      previous = current;
    }
  });

  it("blocks formal planning before the complete harness reaches QA READY", () => {
    const packageInstructions = readRepoFile("packages/qa/AGENTS.md");
    const planTemplate = readRepoFile("packages/qa/templates/qa-plan.md");

    expect(packageInstructions).toContain("Do not select cases or write the formal task QA plan before");
    expect(planTemplate).toContain("Create only after the complete harness is `QA READY`.");
  });

  it("keeps every case disposition aligned in the skill and report template", () => {
    const skill = readRepoFile("skills/first-tree-qa/SKILL.md");
    const reportTemplate = readRepoFile("packages/qa/templates/qa-report.md");

    for (const disposition of dispositions) {
      expect(skill).toContain(`\`${disposition}\``);
      expect(reportTemplate).toContain(`\`${disposition}\``);
    }
  });

  it("rejects the superseded task-first harness language", () => {
    const files = [
      "skills/first-tree-qa/SKILL.md",
      "packages/qa/AGENTS.md",
      "packages/qa/README.md",
      "packages/qa/briefings/setup.md",
      "packages/qa/briefings/plan.md",
      "packages/qa/environment/README.md",
    ];
    const combined = files.map(readRepoFile).join("\n");

    expect(combined).not.toMatch(/smallest isolated run cell/iu);
    expect(combined).not.toMatch(/run only the services needed/iu);
    expect(combined).not.toMatch(/decide run cell shape/iu);
  });
});
