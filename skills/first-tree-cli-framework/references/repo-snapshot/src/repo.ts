import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const FRONTMATTER_RE = /^---\s*\n(.*?)\n---/s;
const OWNERS_RE = /^owners:\s*\[([^\]]*)\]/m;
const TITLE_RE = /^title:\s*['"]?(.+?)['"]?\s*$/m;

export const FRAMEWORK_BEGIN_MARKER = "<!-- BEGIN CONTEXT-TREE FRAMEWORK";
export const FRAMEWORK_END_MARKER = "<!-- END CONTEXT-TREE FRAMEWORK -->";

export interface Frontmatter {
  title?: string;
  owners?: string[];
}

export class Repo {
  readonly root: string;

  constructor(root?: string) {
    this.root = resolve(root ?? process.cwd());
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
    try {
      return statSync(join(this.root, ".git")).isDirectory();
    } catch {
      return false;
    }
  }

  hasFramework(): boolean {
    return this.pathExists(".context-tree/VERSION");
  }

  readVersion(): string | null {
    const text = this.readFile(".context-tree/VERSION");
    return text ? text.trim() : null;
  }

  hasAgentMdMarkers(): boolean {
    const text = this.readFile("AGENT.md");
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

  hasUpstreamRemote(): boolean {
    try {
      const result = execFileSync("git", ["remote"], {
        cwd: this.root,
        encoding: "utf-8",
      });
      return result.split(/\s+/).includes("context-tree-upstream");
    } catch {
      return false;
    }
  }
}
