import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export const SKILL_NAME = "first-tree";
// BUNDLED_SKILL_ROOT points at the source-side payload inside the published
// package. After the Phase 0 layout split it lives under `skills/tree/`.
// SKILL_ROOT still targets the user-installed path `.agents/skills/first-tree/`
// because the installed shape is part of the user-facing contract and did not
// change.
export const BUNDLED_SKILL_ROOT = join("skills", "tree");
export const SKILL_ROOT = join(".agents", "skills", SKILL_NAME);
export const CLAUDE_SKILL_ROOT = join(".claude", "skills", SKILL_NAME);
export const INSTALLED_SKILL_ROOTS = [SKILL_ROOT, CLAUDE_SKILL_ROOT] as const;
export const FIRST_TREE_INDEX_FILE = "WHITEPAPER.md";
export const TREE_RUNTIME_ROOT = ".first-tree";
export const TREE_VERSION = join(TREE_RUNTIME_ROOT, "VERSION");
export const TREE_PROGRESS = join(TREE_RUNTIME_ROOT, "progress.md");
export const TREE_BOOTSTRAP_STATE = join(TREE_RUNTIME_ROOT, "bootstrap.json");
export const TREE_STATE = join(TREE_RUNTIME_ROOT, "tree.json");
export const TREE_BINDINGS_DIR = join(TREE_RUNTIME_ROOT, "bindings");
export const TREE_SUBMODULES_DIR = join(TREE_RUNTIME_ROOT, "submodules");
export const TREE_SOURCE_REPOS_FILE = "source-repos.md";
export const LOCAL_TREE_TEMP_ROOT = join(TREE_RUNTIME_ROOT, "tmp");
export const SOURCE_STATE = join(TREE_RUNTIME_ROOT, "source.json");
export const SOURCE_LOCAL_STATE = join(TREE_RUNTIME_ROOT, "source.local.json");

export const SKILL_AGENTS_DIR = join(SKILL_ROOT, "agents");
export const SKILL_REFERENCES_DIR = join(SKILL_ROOT, "references");
export const INSTALLED_SKILL_VERSION = join(SKILL_ROOT, "VERSION");
export const FRAMEWORK_ASSET_ROOT = join(SKILL_ROOT, "assets", "framework");
export const FRAMEWORK_MANIFEST = join(FRAMEWORK_ASSET_ROOT, "manifest.json");
export const FRAMEWORK_VERSION = join(FRAMEWORK_ASSET_ROOT, "VERSION");
export const FRAMEWORK_TEMPLATES_DIR = join(FRAMEWORK_ASSET_ROOT, "templates");
export const FRAMEWORK_WORKFLOWS_DIR = join(FRAMEWORK_ASSET_ROOT, "workflows");
export const FRAMEWORK_PROMPTS_DIR = join(FRAMEWORK_ASSET_ROOT, "prompts");
export const FRAMEWORK_EXAMPLES_DIR = join(FRAMEWORK_ASSET_ROOT, "examples");
export const FRAMEWORK_HELPERS_DIR = join(FRAMEWORK_ASSET_ROOT, "helpers");
export const INSTALLED_PROGRESS = join(SKILL_ROOT, "progress.md");
export const BOOTSTRAP_STATE = TREE_BOOTSTRAP_STATE;
export const AGENT_INSTRUCTIONS_FILE = "AGENTS.md";
export const LEGACY_AGENT_INSTRUCTIONS_FILE = "AGENT.md";
export const AGENT_INSTRUCTIONS_TEMPLATE = "agents.md.template";
export const CLAUDE_INSTRUCTIONS_FILE = "CLAUDE.md";
export const SOURCE_INTEGRATION_MARKER = "FIRST-TREE-SOURCE-INTEGRATION:";
export const TREE_REPO_MARKER = "FIRST-TREE-TREE-REPO:";
export const TREE_REPO_URL_MARKER = "FIRST-TREE-TREE-REPO-URL:";
export const TREE_MODE_MARKER = "FIRST-TREE-TREE-MODE:";
export const BINDING_MODE_MARKER = "FIRST-TREE-BINDING-MODE:";
export const ENTRYPOINT_MARKER = "FIRST-TREE-ENTRYPOINT:";
export const WORKSPACE_ID_MARKER = "FIRST-TREE-WORKSPACE-ID:";
export const SOURCE_STATE_MARKER = "FIRST-TREE-SOURCE-STATE:";
export const SOURCE_INTEGRATION_BEGIN = "<!-- BEGIN FIRST-TREE-SOURCE-INTEGRATION -->";
export const SOURCE_INTEGRATION_END = "<!-- END FIRST-TREE-SOURCE-INTEGRATION -->";
export const SOURCE_INTEGRATION_FILES = [
  AGENT_INSTRUCTIONS_FILE,
  CLAUDE_INSTRUCTIONS_FILE,
] as const;

export const CLAUDE_SKILL_AGENTS_DIR = join(CLAUDE_SKILL_ROOT, "agents");
export const CLAUDE_SKILL_REFERENCES_DIR = join(CLAUDE_SKILL_ROOT, "references");
export const CLAUDE_FRAMEWORK_ASSET_ROOT = join(
  CLAUDE_SKILL_ROOT,
  "assets",
  "framework",
);
export const CLAUDE_FRAMEWORK_MANIFEST = join(
  CLAUDE_FRAMEWORK_ASSET_ROOT,
  "manifest.json",
);
export const CLAUDE_FRAMEWORK_VERSION = join(
  CLAUDE_FRAMEWORK_ASSET_ROOT,
  "VERSION",
);
export const CLAUDE_FRAMEWORK_TEMPLATES_DIR = join(
  CLAUDE_FRAMEWORK_ASSET_ROOT,
  "templates",
);
export const CLAUDE_FRAMEWORK_WORKFLOWS_DIR = join(
  CLAUDE_FRAMEWORK_ASSET_ROOT,
  "workflows",
);
export const CLAUDE_FRAMEWORK_PROMPTS_DIR = join(
  CLAUDE_FRAMEWORK_ASSET_ROOT,
  "prompts",
);
export const CLAUDE_FRAMEWORK_EXAMPLES_DIR = join(
  CLAUDE_FRAMEWORK_ASSET_ROOT,
  "examples",
);
export const CLAUDE_FRAMEWORK_HELPERS_DIR = join(
  CLAUDE_FRAMEWORK_ASSET_ROOT,
  "helpers",
);
export const CLAUDE_INSTALLED_PROGRESS = join(
  CLAUDE_SKILL_ROOT,
  "progress.md",
);
export const LEGACY_BOOTSTRAP_STATE = join(SKILL_ROOT, "bootstrap.json");

export const LEGACY_REPO_SKILL_ROOT = join("skills", SKILL_NAME);
export const LEGACY_REPO_SKILL_AGENTS_DIR = join(
  LEGACY_REPO_SKILL_ROOT,
  "agents",
);
export const LEGACY_REPO_SKILL_REFERENCES_DIR = join(
  LEGACY_REPO_SKILL_ROOT,
  "references",
);
export const LEGACY_REPO_SKILL_ASSET_ROOT = join(
  LEGACY_REPO_SKILL_ROOT,
  "assets",
  "framework",
);
export const LEGACY_REPO_SKILL_MANIFEST = join(
  LEGACY_REPO_SKILL_ASSET_ROOT,
  "manifest.json",
);
export const LEGACY_REPO_SKILL_VERSION = join(
  LEGACY_REPO_SKILL_ASSET_ROOT,
  "VERSION",
);
export const LEGACY_REPO_SKILL_TEMPLATES_DIR = join(
  LEGACY_REPO_SKILL_ASSET_ROOT,
  "templates",
);
export const LEGACY_REPO_SKILL_WORKFLOWS_DIR = join(
  LEGACY_REPO_SKILL_ASSET_ROOT,
  "workflows",
);
export const LEGACY_REPO_SKILL_PROMPTS_DIR = join(
  LEGACY_REPO_SKILL_ASSET_ROOT,
  "prompts",
);
export const LEGACY_REPO_SKILL_EXAMPLES_DIR = join(
  LEGACY_REPO_SKILL_ASSET_ROOT,
  "examples",
);
export const LEGACY_REPO_SKILL_HELPERS_DIR = join(
  LEGACY_REPO_SKILL_ASSET_ROOT,
  "helpers",
);
export const LEGACY_REPO_SKILL_PROGRESS = join(
  LEGACY_REPO_SKILL_ROOT,
  "progress.md",
);

export const LEGACY_FRAMEWORK_ROOT = ".context-tree";
export const LEGACY_VERSION = join(LEGACY_FRAMEWORK_ROOT, "VERSION");
export const LEGACY_PROGRESS = join(LEGACY_FRAMEWORK_ROOT, "progress.md");
export const LEGACY_TEMPLATES_DIR = join(LEGACY_FRAMEWORK_ROOT, "templates");
export const LEGACY_WORKFLOWS_DIR = join(LEGACY_FRAMEWORK_ROOT, "workflows");
export const LEGACY_PROMPTS_DIR = join(LEGACY_FRAMEWORK_ROOT, "prompts");
export const LEGACY_EXAMPLES_DIR = join(LEGACY_FRAMEWORK_ROOT, "examples");

export type FrameworkLayout =
  | "skill"
  | "lightweight-skill"
  | "tree"
  | "claude-skill"
  | "legacy-repo-skill"
  | "legacy";

function pathExists(root: string, relPath: string): boolean {
  const fullPath = join(root, relPath);
  try {
    return existsSync(fullPath);
  } catch {
    return false;
  }
}

export function installedSkillRoots(): string[] {
  return [...INSTALLED_SKILL_ROOTS];
}

export function installedSkillRootsDisplay(): string {
  return installedSkillRoots()
    .map((root) => `\`${root}/\``)
    .join(" and ");
}

export function frameworkVersionCandidates(): string[] {
  return [
    INSTALLED_SKILL_VERSION,
    FRAMEWORK_VERSION,
    TREE_VERSION,
    CLAUDE_FRAMEWORK_VERSION,
    LEGACY_REPO_SKILL_VERSION,
    LEGACY_VERSION,
  ];
}

export function progressFileCandidates(): string[] {
  return [
    INSTALLED_PROGRESS,
    TREE_PROGRESS,
    CLAUDE_INSTALLED_PROGRESS,
    LEGACY_REPO_SKILL_PROGRESS,
    LEGACY_PROGRESS,
  ];
}

export function agentInstructionsFileCandidates(): string[] {
  return [AGENT_INSTRUCTIONS_FILE, LEGACY_AGENT_INSTRUCTIONS_FILE];
}

export function frameworkTemplateDirCandidates(): string[] {
  return [
    FRAMEWORK_TEMPLATES_DIR,
    CLAUDE_FRAMEWORK_TEMPLATES_DIR,
    LEGACY_REPO_SKILL_TEMPLATES_DIR,
    LEGACY_TEMPLATES_DIR,
  ];
}

export function frameworkWorkflowDirCandidates(): string[] {
  return [
    FRAMEWORK_WORKFLOWS_DIR,
    CLAUDE_FRAMEWORK_WORKFLOWS_DIR,
    LEGACY_REPO_SKILL_WORKFLOWS_DIR,
    LEGACY_WORKFLOWS_DIR,
  ];
}

export function frameworkPromptDirCandidates(): string[] {
  return [
    FRAMEWORK_PROMPTS_DIR,
    CLAUDE_FRAMEWORK_PROMPTS_DIR,
    LEGACY_REPO_SKILL_PROMPTS_DIR,
    LEGACY_PROMPTS_DIR,
  ];
}

export function frameworkExampleDirCandidates(): string[] {
  return [
    FRAMEWORK_EXAMPLES_DIR,
    CLAUDE_FRAMEWORK_EXAMPLES_DIR,
    LEGACY_REPO_SKILL_EXAMPLES_DIR,
    LEGACY_EXAMPLES_DIR,
  ];
}

export function resolveFirstExistingPath(
  root: string,
  candidates: string[],
): string | null {
  for (const candidate of candidates) {
    if (pathExists(root, candidate)) {
      return candidate;
    }
  }
  return null;
}

export function detectFrameworkLayout(root: string): FrameworkLayout | null {
  if (pathExists(root, TREE_VERSION)) {
    return "tree";
  }
  if (
    pathExists(root, join(SKILL_ROOT, "SKILL.md")) &&
    pathExists(root, INSTALLED_SKILL_VERSION) &&
    !pathExists(root, FRAMEWORK_ASSET_ROOT)
  ) {
    return "lightweight-skill";
  }
  if (pathExists(root, FRAMEWORK_VERSION)) {
    return "skill";
  }
  if (pathExists(root, CLAUDE_FRAMEWORK_VERSION)) {
    return "claude-skill";
  }
  if (pathExists(root, LEGACY_REPO_SKILL_VERSION)) {
    return "legacy-repo-skill";
  }
  if (pathExists(root, LEGACY_VERSION)) {
    return "legacy";
  }
  return null;
}

export function isDirectory(root: string, relPath: string): boolean {
  try {
    return statSync(join(root, relPath)).isDirectory();
  } catch {
    return false;
  }
}
