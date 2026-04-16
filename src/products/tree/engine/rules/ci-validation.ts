import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Repo } from "#products/tree/engine/repo.js";
import type { RuleResult } from "#products/tree/engine/rules/index.js";

const BUNDLED_WORKFLOW_SOURCE = "the bundled first-tree workflow templates";

export function evaluate(repo: Repo): RuleResult {
  const tasks: string[] = [];
  let hasValidation = false;
  let hasCodeowners = false;
  const workflowsDir = join(repo.root, ".github", "workflows");
  try {
    if (statSync(workflowsDir).isDirectory()) {
      for (const name of readdirSync(workflowsDir)) {
        if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
        const fullPath = join(workflowsDir, name);
        try {
          if (!statSync(fullPath).isFile()) continue;
          const content = readFileSync(fullPath, "utf-8");
          if (
            content.includes("validate_nodes") ||
            content.includes("validate_members")
          ) {
            hasValidation = true;
          }
          if (content.includes("generate-codeowners")) {
            hasCodeowners = true;
          }
        } catch {
          continue;
        }
      }
    }
  } catch {
    // workflows dir doesn't exist
  }
  if (!hasValidation) {
    tasks.push(
      `No validation workflow found — copy \`validate.yml\` from ${BUNDLED_WORKFLOW_SOURCE} to \`.github/workflows/validate.yml\``,
    );
  }
  if (!hasCodeowners) {
    tasks.push(
      "No CODEOWNERS workflow found — copy `codeowners.yml` from the bundled first-tree workflow templates to `.github/workflows/codeowners.yml` to auto-generate CODEOWNERS from tree ownership on every PR.",
    );
  }
  return { group: "CI / Validation", order: 6, tasks };
}
