import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  AGENT_INSTRUCTIONS_FILE,
  CLAUDE_INSTRUCTIONS_FILE,
  CLAUDE_FRAMEWORK_VERSION,
  CLAUDE_INSTALLED_PROGRESS,
  FRAMEWORK_VERSION,
  FIRST_TREE_INDEX_FILE,
  INSTALLED_PROGRESS,
  INSTALLED_SKILL_VERSION,
  LEGACY_AGENT_INSTRUCTIONS_FILE,
  LEGACY_PROGRESS,
  LEGACY_REPO_SKILL_PROGRESS,
  LEGACY_REPO_SKILL_VERSION,
  LEGACY_VERSION,
  TREE_PROGRESS,
  TREE_VERSION,
  agentInstructionsFileCandidates,
  installedSkillRoots,
  type FrameworkLayout,
  detectFrameworkLayout,
  frameworkVersionCandidates,
  progressFileCandidates,
  resolveFirstExistingPath,
  SOURCE_INTEGRATION_FILES,
  SOURCE_INTEGRATION_MARKER,
} from "#engine/runtime/asset-loader.js";

const FRONTMATTER_RE = /^---\s*\n(.*?)\n---/s;
const OWNERS_RE = /^owners:\s*\[([^\]]*)\]/m;
const TITLE_RE = /^title:\s*['"]?(.+?)['"]?\s*$/m;
const EMPTY_REPO_ENTRY_ALLOWLIST = new Set([
  ".agents",
  ".first-tree",
  ".DS_Store",
  ".claude",
  ".editorconfig",
  ".gitattributes",
  ".github",
  ".gitignore",
  "AGENT.md",
  "AGENTS.md",
  "CLAUDE.md",
  FIRST_TREE_INDEX_FILE,
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "README",
  "README.md",
  "README.txt",
]);
const SOURCE_FILE_HINTS = new Set([
  ".gitmodules",
  "Cargo.toml",
  "Dockerfile",
  "Gemfile",
  "Makefile",
  "bun.lock",
  "bun.lockb",
  "docker-compose.yml",
  "go.mod",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "pyproject.toml",
  "requirements.txt",
  "tsconfig.json",
  "uv.lock",
  "vite.config.ts",
  "vite.config.js",
]);
const SOURCE_DIR_HINTS = new Set([
  "app",
  "apps",
  "backend",
  "cli",
  "client",
  "docs",
  "e2e",
  "frontend",
  "lib",
  "packages",
  "scripts",
  "server",
  "src",
  "test",
  "tests",
]);

export const FRAMEWORK_BEGIN_MARKER = "<!-- BEGIN CONTEXT-TREE FRAMEWORK";
export const FRAMEWORK_END_MARKER = "<!-- END CONTEXT-TREE FRAMEWORK -->";
export const PROJECT_SPECIFIC_INSTRUCTIONS_HEADER =
  "# Project-Specific Instructions";
export const PROJECT_SPECIFIC_INSTRUCTIONS_PLACEHOLDER =
  "<!-- Add your project-specific agent instructions below this line. -->";
const PROJECT_SPECIFIC_PLACEHOLDER_RE =
  /# Project-Specific Instructions\s*\n(?:\s*\n)*<!-- Add your project-specific agent instructions below this line\. -->/g;

export function countProjectSpecificPlaceholderBlocks(text: string): number {
  const normalized = text.replaceAll("\r\n", "\n");
  const markerIndex = normalized.indexOf(FRAMEWORK_END_MARKER);
  const searchText =
    markerIndex >= 0
      ? normalized.slice(markerIndex + FRAMEWORK_END_MARKER.length)
      : normalized;
  return searchText.match(PROJECT_SPECIFIC_PLACEHOLDER_RE)?.length ?? 0;
}

export interface Frontmatter {
  title?: string;
  owners?: string[];
}

function hasGitMetadata(root: string): boolean {
  try {
    const stat = statSync(join(root, ".git"));
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

function discoverGitRoot(start: string): string | null {
  let dir = start;
  while (true) {
    if (hasGitMetadata(dir)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

export class Repo {
  readonly root: string;

  constructor(root?: string) {
    const start = resolve(root ?? process.cwd());
    this.root = root === undefined ? discoverGitRoot(start) ?? start : start;
  }

  pathExists(relPath: string): boolean {
    return existsSync(join(this.root, relPath));
  }

  fileContains(relPath: string, text: string): boolean {
    const fullPath = join(this.root, relPath);
    try {
      const stat = statSync(fullPath);
      if (!stat.isFile()) return false;
      return readFileSync(fullPath, "utf-8").includes(text);
    } catch {
      return false;
    }
  }

  readFile(relPath: string): string | null {
    try {
      return readFileSync(join(this.root, relPath), "utf-8");
    } catch {
      return null;
    }
  }

  frontmatter(relPath: string): Frontmatter | null {
    const text = this.readFile(relPath);
    if (text === null) return null;
    const m = text.match(FRONTMATTER_RE);
    if (!m) return null;
    const fm = m[1];
    const result: Frontmatter = {};
    const titleM = fm.match(TITLE_RE);
    if (titleM) {
      result.title = titleM[1].trim();
    }
    const ownersM = fm.match(OWNERS_RE);
    if (ownersM) {
      const raw = ownersM[1].trim();
      result.owners = raw
        ? raw.split(",").map((o) => o.trim()).filter(Boolean)
        : [];
    }
    return result.title !== undefined || result.owners !== undefined
      ? result
      : null;
  }

  anyAgentConfig(): boolean {
    const knownConfigs = [".claude/settings.json", ".codex/config.json"];
    return knownConfigs.some((c) => this.pathExists(c));
  }

  installedSkillRoots(): string[] {
    return installedSkillRoots();
  }

  missingInstalledSkillRoots(): string[] {
    return this.installedSkillRoots().filter(
      (root) =>
        !this.pathExists(join(root, "SKILL.md")) ||
        !this.pathExists(join(root, "VERSION")),
    );
  }

  hasCurrentInstalledSkill(): boolean {
    return this.missingInstalledSkillRoots().length === 0;
  }

  isGitRepo(): boolean {
    return hasGitMetadata(this.root);
  }

  hasFramework(): boolean {
    return this.frameworkLayout() !== null;
  }

  frameworkLayout(): FrameworkLayout | null {
    return detectFrameworkLayout(this.root);
  }

  readVersion(): string | null {
    const versionPath = resolveFirstExistingPath(
      this.root,
      frameworkVersionCandidates(),
    );
    if (versionPath === null) return null;
    const text = this.readFile(versionPath);
    return text ? text.trim() : null;
  }

  progressPath(): string | null {
    return resolveFirstExistingPath(this.root, progressFileCandidates());
  }

  preferredProgressPath(): string {
    const layout = this.frameworkLayout();
    if (layout === "legacy") {
      return LEGACY_PROGRESS;
    }
    if (layout === "legacy-repo-skill") {
      return LEGACY_REPO_SKILL_PROGRESS;
    }
    if (layout === "claude-skill") {
      return CLAUDE_INSTALLED_PROGRESS;
    }
    if (layout === "tree") {
      return TREE_PROGRESS;
    }
    return INSTALLED_PROGRESS;
  }

  frameworkVersionPath(): string {
    const layout = this.frameworkLayout();
    if (layout === "legacy") {
      return LEGACY_VERSION;
    }
    if (layout === "legacy-repo-skill") {
      return LEGACY_REPO_SKILL_VERSION;
    }
    if (layout === "claude-skill") {
      return CLAUDE_FRAMEWORK_VERSION;
    }
    if (layout === "tree") {
      return TREE_VERSION;
    }
    if (layout === "lightweight-skill") {
      return INSTALLED_SKILL_VERSION;
    }
    return FRAMEWORK_VERSION;
  }

  agentInstructionsPath(): string | null {
    return resolveFirstExistingPath(this.root, agentInstructionsFileCandidates());
  }

  hasCanonicalAgentInstructionsFile(): boolean {
    return this.pathExists(AGENT_INSTRUCTIONS_FILE);
  }

  hasLegacyAgentInstructionsFile(): boolean {
    return this.pathExists(LEGACY_AGENT_INSTRUCTIONS_FILE);
  }

  hasDuplicateAgentInstructionsFiles(): boolean {
    return this.hasCanonicalAgentInstructionsFile() && this.hasLegacyAgentInstructionsFile();
  }

  readAgentInstructions(): string | null {
    const relPath = this.agentInstructionsPath();
    if (relPath === null) return null;
    return this.readFile(relPath);
  }

  hasAgentInstructionsMarkers(): boolean {
    const text = this.readAgentInstructions();
    if (text === null) return false;
    return text.includes(FRAMEWORK_BEGIN_MARKER) && text.includes(FRAMEWORK_END_MARKER);
  }

  hasClaudeInstructionsFile(): boolean {
    return this.pathExists(CLAUDE_INSTRUCTIONS_FILE);
  }

  readClaudeInstructions(): string | null {
    return this.readFile(CLAUDE_INSTRUCTIONS_FILE);
  }

  hasClaudeInstructionsMarkers(): boolean {
    return this.hasFrameworkMarkersInFile(CLAUDE_INSTRUCTIONS_FILE);
  }

  private hasFrameworkMarkersInFile(relPath: string): boolean {
    const text = this.readFile(relPath);
    if (text === null) return false;
    return text.includes(FRAMEWORK_BEGIN_MARKER) && text.includes(FRAMEWORK_END_MARKER);
  }

  hasSourceIntegrationFile(relPath: string): boolean {
    return this.fileContains(relPath, SOURCE_INTEGRATION_MARKER);
  }

  hasSourceWorkspaceIntegration(): boolean {
    return SOURCE_INTEGRATION_FILES.some((file) => this.hasSourceIntegrationFile(file));
  }

  hasTreeContent(): boolean {
    return (
      this.progressPath() !== null
      || this.hasAgentInstructionsMarkers()
      || this.pathExists("members/NODE.md")
      || this.frontmatter("NODE.md") !== null
    );
  }

  hasMembers(): boolean {
    const membersDir = join(this.root, "members");
    try {
      if (!statSync(membersDir).isDirectory()) return false;
    } catch {
      return false;
    }
    return existsSync(join(membersDir, "NODE.md"));
  }

  memberCount(): number {
    const membersDir = join(this.root, "members");
    try {
      if (!statSync(membersDir).isDirectory()) return 0;
    } catch {
      return 0;
    }
    let count = 0;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const childPath = join(dir, entry);
        try {
          if (!statSync(childPath).isDirectory()) continue;
        } catch {
          continue;
        }
        if (existsSync(join(childPath, "NODE.md"))) {
          count++;
        }
        walk(childPath);
      }
    };
    walk(membersDir);
    return count;
  }

  hasPlaceholderNode(): boolean {
    return this.fileContains("NODE.md", "<!-- PLACEHOLDER");
  }

  repoName(): string {
    return basename(this.root);
  }

  topLevelEntries(): string[] {
    try {
      return readdirSync(this.root).filter((entry) => entry !== ".git");
    } catch {
      return [];
    }
  }

  looksLikeTreeRepo(): boolean {
    if (
      this.pathExists("package.json")
      && this.pathExists("src/cli.ts")
      && this.pathExists("skills/first-tree/SKILL.md")
      && this.progressPath() === null
      && this.frontmatter("NODE.md") === null
      && !this.hasAgentInstructionsMarkers()
      && !this.pathExists("members/NODE.md")
    ) {
      return false;
    }

    if (this.hasTreeContent()) {
      return true;
    }

    if (this.hasFramework() && this.hasSourceWorkspaceIntegration()) {
      return false;
    }

    if (this.hasFramework()) {
      return !this.hasLikelySourceRepoSignals();
    }

    return false;
  }

  isLikelyEmptyRepo(): boolean {
    const relevant = this.topLevelEntries().filter(
      (entry) => !EMPTY_REPO_ENTRY_ALLOWLIST.has(entry),
    );
    return relevant.length === 0;
  }

  isLikelySourceRepo(): boolean {
    if (this.looksLikeTreeRepo()) {
      return false;
    }

    return this.hasLikelySourceRepoSignals();
  }

  private hasLikelySourceRepoSignals(): boolean {
    const entries = this.topLevelEntries().filter(
      (entry) => !EMPTY_REPO_ENTRY_ALLOWLIST.has(entry),
    );
    if (entries.length === 0) {
      return false;
    }

    let directoryCount = 0;

    for (const entry of entries) {
      if (SOURCE_FILE_HINTS.has(entry)) {
        return true;
      }
      if (isDirectory(this.root, entry)) {
        directoryCount += 1;
        if (SOURCE_DIR_HINTS.has(entry)) {
          return true;
        }
      }
    }

    return directoryCount >= 2 || entries.length >= 4;
  }
}

function isDirectory(root: string, relPath: string): boolean {
  try {
    return statSync(join(root, relPath)).isDirectory();
  } catch {
    return false;
  }
}
