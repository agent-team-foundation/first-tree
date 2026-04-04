import { join } from "node:path";
import {
  CLAUDE_FRAMEWORK_EXAMPLES_DIR,
  CLAUDE_FRAMEWORK_HELPERS_DIR,
  FRAMEWORK_EXAMPLES_DIR,
  LEGACY_REPO_SKILL_EXAMPLES_DIR,
  LEGACY_SKILL_EXAMPLES_DIR,
  LEGACY_EXAMPLES_DIR,
} from "#skill/engine/runtime/asset-loader.js";

export const CLAUDE_SETTINGS_PATH = ".claude/settings.json";
export const CODEX_CONFIG_PATH = ".codex/config.json";

export function claudeCodeExampleCandidates(): string[] {
  return [
    join(CLAUDE_FRAMEWORK_EXAMPLES_DIR, "claude-code"),
    join(FRAMEWORK_EXAMPLES_DIR, "claude-code"),
    join(LEGACY_REPO_SKILL_EXAMPLES_DIR, "claude-code"),
    join(LEGACY_SKILL_EXAMPLES_DIR, "claude-code"),
    join(LEGACY_EXAMPLES_DIR, "claude-code"),
  ];
}

export function injectTreeContextHint(): string {
  return join(CLAUDE_FRAMEWORK_HELPERS_DIR, "inject-tree-context.sh");
}
