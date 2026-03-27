import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Repo } from "../repo.js";
import type { RuleResult } from "./index.js";

export function evaluate(repo: Repo): RuleResult {
  const tasks: string[] = [];
  let hasValidation = false;
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
            break;
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
      "No validation workflow found — copy `.context-tree/workflows/validate.yml` to `.github/workflows/validate.yml`",
    );
  }
  return { group: "CI / Validation", order: 6, tasks };
}
