import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  AGENT_INSTRUCTIONS_FILE,
  FRAMEWORK_VERSION,
  LEGACY_SKILL_PROGRESS,
  LEGACY_SKILL_VERSION,
  LEGACY_AGENT_INSTRUCTIONS_FILE,
  LEGACY_PROGRESS,
  LEGACY_VERSION,
  INSTALLED_PROGRESS,
  agentInstructionsFileCandidates,
  type FrameworkLayout,
  detectFrameworkLayout,
  frameworkVersionCandidates,
  progressFileCandidates,
  resolveFirstExistingPath,
} from "#skill/engine/runtime/asset-loader.js";

const FRONTMATTER_RE = /^---\s*\n(.*?)\n---/s;
const OWNERS_RE = /^owners:\s*\[([^\]]*)\]/m;
const TITLE_RE = /^title:\s*['"]?(.+?)['"]?\s*$/m;
const EMPTY_REPO_ENTRY_ALLOWLIST = new Set([
  ".DS_Store",
  ".editorconfig",
  ".gitattributes",
  ".github",
  ".gitignore",
  "AGENT.md",
  "AGENTS.md",
  "CLAUDE.md",
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
    if (layout === "legacy-skill") {
      return LEGACY_SKILL_PROGRESS;
    }
    return INSTALLED_PROGRESS;
  }

  frameworkVersionPath(): string {
    const layout = this.frameworkLayout();
    if (layout === "legacy") {
      return LEGACY_VERSION;
    }
    if (layout === "legacy-skill") {
      return LEGACY_SKILL_VERSION;
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

    return (
      this.progressPath() !== null
      || this.hasFramework()
      || this.hasAgentInstructionsMarkers()
      || this.pathExists("members/NODE.md")
      || this.frontmatter("NODE.md") !== null
    );
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
