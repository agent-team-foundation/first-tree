import {
  countProjectSpecificPlaceholderBlocks,
  FRAMEWORK_END_MARKER,
  PROJECT_SPECIFIC_INSTRUCTIONS_HEADER,
} from "#engine/repo.js";
import type { Repo } from "#engine/repo.js";
import type { RuleResult } from "#engine/rules/index.js";
import {
  AGENT_INSTRUCTIONS_FILE,
  AGENT_INSTRUCTIONS_TEMPLATE,
  CLAUDE_INSTRUCTIONS_FILE,
  FRAMEWORK_TEMPLATES_DIR,
  LEGACY_AGENT_INSTRUCTIONS_FILE,
} from "#engine/runtime/asset-loader.js";

export function evaluate(repo: Repo): RuleResult {
  const tasks: string[] = [];
  const hasCanonicalInstructions = repo.hasCanonicalAgentInstructionsFile();
  const hasLegacyInstructions = repo.hasLegacyAgentInstructionsFile();
  const hasClaudeInstructions = repo.hasClaudeInstructionsFile();

  if (!hasCanonicalInstructions && !hasLegacyInstructions) {
    tasks.push(
      `${AGENT_INSTRUCTIONS_FILE} is missing — create from \`${FRAMEWORK_TEMPLATES_DIR}/${AGENT_INSTRUCTIONS_TEMPLATE}\``,
    );
  }
  if (!hasClaudeInstructions) {
    tasks.push(
      `${CLAUDE_INSTRUCTIONS_FILE} is missing — create as a symlink to \`${AGENT_INSTRUCTIONS_FILE}\` so the two files can never drift (\`ln -s ${AGENT_INSTRUCTIONS_FILE} ${CLAUDE_INSTRUCTIONS_FILE}\`)`,
    );
  }
  if (tasks.length > 0 && !hasCanonicalInstructions && !hasLegacyInstructions) {
    return { group: "Agent Instructions", order: 3, tasks };
  }

  if (hasCanonicalInstructions && hasLegacyInstructions) {
    tasks.push(
      `Merge any remaining user-authored content from \`${LEGACY_AGENT_INSTRUCTIONS_FILE}\` into \`${AGENT_INSTRUCTIONS_FILE}\`, then delete the legacy file`,
    );
  } else if (hasLegacyInstructions) {
    tasks.push(
      `Rename \`${LEGACY_AGENT_INSTRUCTIONS_FILE}\` to \`${AGENT_INSTRUCTIONS_FILE}\` to use the canonical agent instructions filename`,
    );
  }

  const instructionsPath = repo.agentInstructionsPath() ?? AGENT_INSTRUCTIONS_FILE;
  if (!repo.hasAgentInstructionsMarkers()) {
    tasks.push(
      `\`${instructionsPath}\` exists but is missing framework markers — add \`<!-- BEGIN CONTEXT-TREE FRAMEWORK -->\` and \`<!-- END CONTEXT-TREE FRAMEWORK -->\` sections`,
    );
  } else {
    const text = repo.readAgentInstructions() ?? "";
    if (countProjectSpecificPlaceholderBlocks(text) > 1) {
      tasks.push(
        `Remove duplicate \`${PROJECT_SPECIFIC_INSTRUCTIONS_HEADER}\` placeholder blocks from ${AGENT_INSTRUCTIONS_FILE}; keep only one copy of the template section`,
      );
    }
    const afterMarker = text.split(FRAMEWORK_END_MARKER);
    if (afterMarker.length > 1) {
      const userSection = afterMarker[1].trim();
      const lines = userSection
        .split("\n")
        .filter(
          (l) =>
            l.trim() &&
            !l.trim().startsWith("#") &&
            !l.trim().startsWith("<!--"),
        );
      if (lines.length === 0) {
        tasks.push(
          `Add your project-specific instructions below the framework markers in ${AGENT_INSTRUCTIONS_FILE}`,
        );
      }
    }
  }

  if (hasClaudeInstructions) {
    const claudeText = repo.readClaudeInstructions() ?? "";
    if (!repo.hasClaudeInstructionsMarkers()) {
      tasks.push(
        `\`${CLAUDE_INSTRUCTIONS_FILE}\` exists but is missing framework markers — add \`<!-- BEGIN CONTEXT-TREE FRAMEWORK -->\` and \`<!-- END CONTEXT-TREE FRAMEWORK -->\` sections`,
      );
    } else {
      if (countProjectSpecificPlaceholderBlocks(claudeText) > 1) {
        tasks.push(
          `Remove duplicate \`${PROJECT_SPECIFIC_INSTRUCTIONS_HEADER}\` placeholder blocks from ${CLAUDE_INSTRUCTIONS_FILE}; keep only one copy of the template section`,
        );
      }
      const afterMarker = claudeText.split(FRAMEWORK_END_MARKER);
      if (afterMarker.length > 1) {
        const userSection = afterMarker[1].trim();
        const lines = userSection
          .split("\n")
          .filter(
            (l) =>
              l.trim() &&
              !l.trim().startsWith("#") &&
              !l.trim().startsWith("<!--"),
          );
        if (lines.length === 0) {
          tasks.push(
            `Add your project-specific instructions below the framework markers in ${CLAUDE_INSTRUCTIONS_FILE}`,
          );
        }
      }
    }
  }
  return { group: "Agent Instructions", order: 3, tasks };
}
