import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLAUDE_FRAMEWORK_EXAMPLES_DIR,
  FRAMEWORK_EXAMPLES_DIR,
  LEGACY_REPO_SKILL_EXAMPLES_DIR,
  LEGACY_EXAMPLES_DIR,
} from "#products/tree/engine/runtime/asset-loader.js";

export const CLAUDE_SETTINGS_PATH = ".claude/settings.json";
export const CODEX_CONFIG_PATH = ".codex/config.json";
export const INJECT_CONTEXT_COMMAND =
  "npx -p first-tree first-tree inject-context --skip-version-check";

const STALE_INJECT_CONTEXT_PATTERNS = [
  /\.agents\/skills\/first-tree\/assets\/framework\/helpers\/inject-tree-context\.sh/g,
  /\.claude\/skills\/first-tree\/assets\/framework\/helpers\/inject-tree-context\.sh/g,
  /skills\/first-tree\/assets\/framework\/helpers\/inject-tree-context\.sh/g,
  /\.context-tree\/helpers\/inject-tree-context\.sh/g,
  /\.context-tree\/scripts\/inject-tree-context\.sh/g,
  /\.scripts\/inject-tree-context\.sh/g,
];

export function claudeCodeExampleCandidates(): string[] {
  return [
    join(CLAUDE_FRAMEWORK_EXAMPLES_DIR, "claude-code"),
    join(FRAMEWORK_EXAMPLES_DIR, "claude-code"),
    join(LEGACY_REPO_SKILL_EXAMPLES_DIR, "claude-code"),
    join(LEGACY_EXAMPLES_DIR, "claude-code"),
  ];
}

export function injectTreeContextHint(): string {
  return INJECT_CONTEXT_COMMAND;
}

/**
 * Update a user repo's `.claude/settings.json` SessionStart hook command if
 * it still references one of the legacy `inject-tree-context.sh` paths. The
 * file's JSON structure is preserved — we only do a textual substitution.
 *
 * Returns "updated" if any substitution was made, "unchanged" if the file
 * is missing, has no stale reference, or already uses the CLI command.
 */
export function refreshInjectContextHook(
  targetRoot: string,
): "updated" | "unchanged" {
  const fullPath = join(targetRoot, CLAUDE_SETTINGS_PATH);
  if (!existsSync(fullPath)) {
    return "unchanged";
  }
  const original = readFileSync(fullPath, "utf-8");
  let updated = original;
  for (const pattern of STALE_INJECT_CONTEXT_PATTERNS) {
    updated = updated.replace(pattern, INJECT_CONTEXT_COMMAND);
  }
  updated = updated.replace(
    /("command"\s*:\s*")(?:\.\/)?scripts\/inject-tree-context\.sh(")/g,
    `$1${INJECT_CONTEXT_COMMAND}$2`,
  );
  // Strip any leading "./" the legacy bash script started with so the
  // command runs cleanly.
  updated = updated.replace(
    /\.\/(npx -p first-tree first-tree inject-context --skip-version-check)/g,
    "$1",
  );
  if (updated === original) {
    return "unchanged";
  }
  writeFileSync(fullPath, updated);
  return "updated";
}

/**
 * Refresh any `.github/workflows/{validate,pr-review,codeowners}.yml` files
 * in the user repo by overwriting them with the bundled workflow templates.
 * Only existing files are overwritten — missing workflows stay missing
 * (the user opted out of them, or hasn't installed them yet).
 *
 * Returns the list of workflow filenames that were overwritten.
 */
export function refreshShippedWorkflows(
  targetRoot: string,
  bundledWorkflowsDir: string,
): string[] {
  const updated: string[] = [];
  const shipped = ["validate.yml", "pr-review.yml", "codeowners.yml"];
  for (const filename of shipped) {
    const targetPath = join(targetRoot, ".github", "workflows", filename);
    if (!existsSync(targetPath)) continue;
    const sourcePath = join(bundledWorkflowsDir, filename);
    if (!existsSync(sourcePath)) continue;
    copyFileSync(sourcePath, targetPath);
    updated.push(filename);
  }
  return updated;
}
