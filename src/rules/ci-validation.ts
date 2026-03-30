import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { INTERACTIVE_TOOL } from "#src/init.js";
import type { Repo } from "#src/repo.js";
import type { RuleResult } from "#src/rules/index.js";

export function evaluate(repo: Repo): RuleResult {
  const tasks: string[] = [];
  let hasValidation = false;
  let hasPrReview = false;
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
          if (content.includes("run-review")) {
            hasPrReview = true;
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
      "No validation workflow found — copy `.context-tree/workflows/validate.yml` to `.github/workflows/validate.yml`",
    );
  }
  if (!hasPrReview) {
    tasks.push(
      `Use ${INTERACTIVE_TOOL} to ask whether the user wants AI-powered PR reviews. Options:\n` +
      "  1. **OpenRouter** — use an OpenRouter API key\n" +
      "  2. **Claude API** — use a Claude API key directly\n" +
      "  3. **Skip** — do not set up PR reviews\n" +
      "If (1): copy `.context-tree/workflows/pr-review.yml` to `.github/workflows/pr-review.yml` as-is; the repo secret name is `OPENROUTER_API_KEY`. " +
      "If (2): copy the workflow and replace the `env` block with `ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}`, remove the `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_DEFAULT_SONNET_MODEL` lines; the repo secret name is `ANTHROPIC_API_KEY`. " +
      "If (3): skip this and the next task.",
    );
    tasks.push(
      `Use ${INTERACTIVE_TOOL} to ask how the user wants to configure the API secret. Options:\n` +
      "  1. **Set it now** — provide the key and the agent will run `gh secret set <SECRET_NAME> --body <KEY>`\n" +
      "  2. **I'll do it myself** — the agent will show manual instructions\n" +
      "If (1): ask the user to provide the key, then run `gh secret set` with the secret name from the previous step. " +
      "If (2): tell the user to go to their repo → Settings → Secrets and variables → Actions → New repository secret, and create the secret with the name from the previous step. " +
      "Skip this task if the user chose Skip in the previous step.",
    );
  }
  if (!hasCodeowners) {
    tasks.push(
      "No CODEOWNERS workflow found — copy `.context-tree/workflows/codeowners.yml` to `.github/workflows/codeowners.yml` to auto-generate CODEOWNERS from tree ownership on every PR.",
    );
  }
  return { group: "CI / Validation", order: 6, tasks };
}
