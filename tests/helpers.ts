import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach } from "vitest";
import {
  AGENT_INSTRUCTIONS_FILE,
  AGENT_INSTRUCTIONS_TEMPLATE,
  CLAUDE_INSTRUCTIONS_FILE,
  CLAUDE_SKILL_ROOT,
  LEGACY_AGENT_INSTRUCTIONS_FILE,
  LEGACY_REPO_SKILL_VERSION,
  LEGACY_VERSION,
  SKILL_ROOT,
  TREE_VERSION,
} from "#products/tree/engine/runtime/asset-loader.js";
import { ensureAgentContextHooks } from "#products/tree/engine/runtime/adapters.js";

interface TmpDir {
  path: string;
}

export function useTmpDir(): TmpDir {
  const dir = mkdtempSync(join(tmpdir(), "ct-test-"));
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return { path: dir };
}

function writeCurrentSkillReferences(skillRoot: string): void {
  writeFileSync(
    join(skillRoot, "references", "whitepaper.md"),
    "# First Tree — White Paper\n",
  );
  writeFileSync(
    join(skillRoot, "references", "onboarding.md"),
    "# Context Tree Onboarding\n",
  );
  writeFileSync(
    join(skillRoot, "references", "source-workspace-installation.md"),
    "# Source/Workspace Installation Contract\n",
  );
  writeFileSync(
    join(skillRoot, "references", "principles.md"),
    "# Tree Principles\n",
  );
  writeFileSync(
    join(skillRoot, "references", "ownership-and-naming.md"),
    "# Node Naming and Ownership Model\n",
  );
  writeFileSync(
    join(skillRoot, "references", "upgrade-contract.md"),
    "# Upgrade Contract\n",
  );
}

export function makeFramework(root: string, version = "0.1.0"): void {
  for (const skillRoot of [SKILL_ROOT, CLAUDE_SKILL_ROOT]) {
    mkdirSync(join(root, skillRoot, "references"), { recursive: true });
    writeFileSync(
      join(root, skillRoot, "SKILL.md"),
      "---\nname: first-tree\ndescription: installed\n---\n",
    );
    writeCurrentSkillReferences(join(root, skillRoot));
    writeFileSync(
      join(root, skillRoot, "VERSION"),
      `${version}\n`,
    );
  }
}

export function makeTreeMetadata(root: string, version = "0.1.0"): void {
  mkdirSync(join(root, ".first-tree"), { recursive: true });
  writeFileSync(join(root, TREE_VERSION), `${version}\n`);
}

export function makeGitRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init"], {
    cwd: root,
    stdio: "ignore",
  });
}

function commitWorkingTree(root: string, message: string): void {
  execFileSync("git", ["add", "-A"], {
    cwd: root,
    stdio: "ignore",
  });
  execFileSync(
    "git",
    [
      "-c",
      "user.email=first-tree-tests@example.com",
      "-c",
      "user.name=First Tree Tests",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgsign=false",
      "commit",
      "-m",
      message,
    ],
    {
      cwd: root,
      stdio: "ignore",
    },
  );
}

export function makeSourceRepo(root: string): void {
  makeGitRepo(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "example-source-repo" }, null, 2),
  );
  writeFileSync(join(root, "src", "index.ts"), "export const ready = true;\n");
  commitWorkingTree(root, "Initial source repo");
}

export function makeManagedAgentContext(root: string): void {
  ensureAgentContextHooks(root);
}

export function makeLegacyFramework(root: string, version = "0.1.0"): void {
  const ct = join(root, ".context-tree");
  mkdirSync(ct, { recursive: true });
  writeFileSync(join(root, LEGACY_VERSION), `${version}\n`);
}

export function makeLegacyRepoFramework(root: string, version = "0.1.0"): void {
  mkdirSync(join(root, "skills", "first-tree", "assets", "framework"), {
    recursive: true,
  });
  writeFileSync(
    join(root, "skills", "first-tree", "SKILL.md"),
    "---\nname: first-tree\ndescription: legacy installed\n---\n",
  );
  writeFileSync(join(root, LEGACY_REPO_SKILL_VERSION), `${version}\n`);
}

export function makeSourceSkill(root: string, version = "0.2.0"): void {
  const skillRoot = join(root, "skills", "first-tree");
  const frameworkRoot = join(root, "assets", "tree");
  mkdirSync(join(root, "agents"), { recursive: true });
  mkdirSync(join(frameworkRoot, "templates"), {
    recursive: true,
  });
  mkdirSync(join(skillRoot, "references"), { recursive: true });

  writeFileSync(
    join(skillRoot, "SKILL.md"),
    "---\nname: first-tree\ndescription: test\n---\n",
  );
  writeFileSync(
    join(skillRoot, "VERSION"),
    `${version}\n`,
  );
  writeFileSync(
    join(root, "agents", "openai.yaml"),
    "display_name: First Tree\nshort_description: test\n",
  );
  writeFileSync(
    join(frameworkRoot, "manifest.json"),
    "{}\n",
  );
  writeCurrentSkillReferences(skillRoot);
  writeFileSync(
    join(frameworkRoot, "VERSION"),
    `${version}\n`,
  );
  writeFileSync(
    join(
      frameworkRoot,
      "templates",
      "root-node.md.template",
    ),
    "---\ntitle: Example Tree\nowners: [alice]\n---\n# Example Tree\n",
  );
  writeFileSync(
    join(
      frameworkRoot,
      "templates",
      AGENT_INSTRUCTIONS_TEMPLATE,
    ),
    "<!-- BEGIN CONTEXT-TREE FRAMEWORK -->\nframework text\n<!-- END CONTEXT-TREE FRAMEWORK -->\n",
  );
  writeFileSync(
    join(
      frameworkRoot,
      "templates",
      "members-domain.md.template",
    ),
    "---\ntitle: Members\nowners: [alice]\n---\n# Members\n",
  );
  writeFileSync(
    join(
      frameworkRoot,
      "templates",
      "member-node.md.template",
    ),
    [
      "---",
      'title: "<Display Name>"',
      "owners: [<github-username>]",
      'type: "<human | personal_assistant | autonomous_agent>"',
      'role: "<role title>"',
      "domains:",
      '  - "<domain>"',
      "---",
      "",
      "# <Display Name>",
      "",
      "## About",
      "",
      "<!-- Who you are and what you bring to the team. -->",
      "",
      "## Current Focus",
      "",
      "<!-- What you're actively working on. -->",
      "",
    ].join("\n"),
  );
}

/**
 * Seed the three per-product skill payloads (tree, breeze, gardener) at
 * the source-package-relative layout the installer expects. `makeSourceSkill`
 * only creates the first-tree entry-point skill; call this in addition when
 * a test needs the full four-skill install to succeed.
 */
export function makeProductSkills(root: string, version = "0.2.0"): void {
  for (const name of ["tree", "breeze", "gardener"] as const) {
    const dir = join(root, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: test stub for ${name}\n---\n`,
    );
    writeFileSync(join(dir, "VERSION"), `${version}\n`);
  }
}

export function makeNode(
  root: string,
  opts?: { placeholder?: boolean },
): void {
  const body = opts?.placeholder
    ? "<!-- PLACEHOLDER -->\n"
    : "# Real content\n";
  writeFileSync(
    join(root, "NODE.md"),
    `---\ntitle: My Org\nowners: [alice]\n---\n${body}`,
  );
}

export function makeAgentsMd(
  root: string,
  opts?: { markers?: boolean; userContent?: boolean; legacyName?: boolean },
): void {
  const markers = opts?.markers ?? true;
  const userContent = opts?.userContent ?? false;
  const fileName = opts?.legacyName
    ? LEGACY_AGENT_INSTRUCTIONS_FILE
    : AGENT_INSTRUCTIONS_FILE;
  const parts: string[] = [];
  if (markers) {
    parts.push(
      "<!-- BEGIN CONTEXT-TREE FRAMEWORK -->\nframework stuff\n<!-- END CONTEXT-TREE FRAMEWORK -->",
    );
  } else {
    parts.push("# Agent instructions\n");
  }
  if (userContent) {
    parts.push("\n# Project-specific\nThis is real user content.\n");
  }
  writeFileSync(join(root, fileName), parts.join("\n"));
}

export function makeClaudeMd(
  root: string,
  opts?: { markers?: boolean; userContent?: boolean },
): void {
  const markers = opts?.markers ?? true;
  const userContent = opts?.userContent ?? false;
  const parts: string[] = [];
  if (markers) {
    parts.push(
      "<!-- BEGIN CONTEXT-TREE FRAMEWORK -->\nframework stuff\n<!-- END CONTEXT-TREE FRAMEWORK -->",
    );
  } else {
    parts.push("# Claude instructions\n");
  }
  if (userContent) {
    parts.push("\n# Project-specific\nThis is real user content.\n");
  }
  writeFileSync(join(root, CLAUDE_INSTRUCTIONS_FILE), parts.join("\n"));
}

export function makeMembers(root: string, count = 1): void {
  const membersDir = join(root, "members");
  mkdirSync(membersDir, { recursive: true });
  writeFileSync(
    join(membersDir, "NODE.md"),
    "---\ntitle: Members\n---\n",
  );
  for (let i = 0; i < count; i++) {
    const d = join(membersDir, `member-${i}`);
    mkdirSync(d);
    writeFileSync(join(d, "NODE.md"), `---\ntitle: Member ${i}\nowners: [member-${i}]\ntype: human\nrole: Engineer\ndomains:\n  - engineering\n---\n`);
  }
}
