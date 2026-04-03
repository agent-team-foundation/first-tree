import { join } from "node:path";
import {
  FRAMEWORK_EXAMPLES_DIR,
  FRAMEWORK_HELPERS_DIR,
  LEGACY_EXAMPLES_DIR,
} from "#src/runtime/asset-loader.js";

export const CLAUDE_SETTINGS_PATH = ".claude/settings.json";
export const CODEX_CONFIG_PATH = ".codex/config.json";

export function claudeCodeExampleCandidates(): string[] {
  return [
    join(FRAMEWORK_EXAMPLES_DIR, "claude-code"),
    join(LEGACY_EXAMPLES_DIR, "claude-code"),
  ];
}

export function injectTreeContextHint(): string {
  return join(FRAMEWORK_HELPERS_DIR, "inject-tree-context.sh");
}
