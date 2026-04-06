import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach } from "vitest";
import {
  AGENT_INSTRUCTIONS_FILE,
  AGENT_INSTRUCTIONS_TEMPLATE,
  CLAUDE_INSTRUCTIONS_FILE,
  CLAUDE_INSTRUCTIONS_TEMPLATE,
  CLAUDE_SKILL_ROOT,
  FRAMEWORK_VERSION,
  LEGACY_AGENT_INSTRUCTIONS_FILE,
  LEGACY_REPO_SKILL_VERSION,
  LEGACY_VERSION,
  SKILL_ROOT,
  TREE_VERSION,
} from "#skill/engine/runtime/asset-loader.js";

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

export function makeFramework(root: string, version = "0.1.0"): void {
  for (const skillRoot of [SKILL_ROOT, CLAUDE_SKILL_ROOT]) {
    mkdirSync(join(root, skillRoot, "assets", "framework"), {
      recursive: true,
    });
    mkdirSync(join(root, skillRoot, "references"), { recursive: true });
    writeFileSync(
      join(root, skillRoot, "SKILL.md"),
      "---\nname: first-tree\ndescription: installed\n---\n",
    );
    writeFileSync(
      join(root, skillRoot, "references", "about.md"),
      "# About Context Tree\n",
    );
  }
  writeFileSync(join(root, FRAMEWORK_VERSION), `${version}\n`);
  writeFileSync(
    join(root, CLAUDE_SKILL_ROOT, "assets", "framework", "VERSION"),
    `${version}\n`,
  );
}

export function makeTreeMetadata(root: string, version = "0.1.0"): void {
  mkdirSync(join(root, ".first-tree"), { recursive: true });
  writeFileSync(join(root, TREE_VERSION), `${version}\n`);
}

export function makeGitRepo(root: string): void {
  mkdirSync(join(root, ".git"), { recursive: true });
}

export function makeSourceRepo(root: string): void {
  makeGitRepo(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "example-source-repo" }, null, 2),
  );
  writeFileSync(join(root, "src", "index.ts"), "export const ready = true;\n");
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
  mkdirSync(join(skillRoot, "agents"), { recursive: true });
  mkdirSync(join(skillRoot, "assets", "framework", "templates"), {
    recursive: true,
  });
  mkdirSync(join(skillRoot, "references"), { recursive: true });

  writeFileSync(
    join(skillRoot, "SKILL.md"),
    "---\nname: first-tree\ndescription: test\n---\n",
  );
  writeFileSync(
    join(skillRoot, "agents", "openai.yaml"),
    "display_name: First Tree\nshort_description: test\n",
  );
  writeFileSync(
    join(skillRoot, "assets", "framework", "manifest.json"),
    "{}\n",
  );
  writeFileSync(
    join(skillRoot, "references", "about.md"),
    "# About Context Tree\n",
  );
  writeFileSync(
    join(skillRoot, "assets", "framework", "VERSION"),
    `${version}\n`,
  );
  writeFileSync(
    join(
      skillRoot,
      "assets",
      "framework",
      "templates",
      "root-node.md.template",
    ),
    "---\ntitle: Example Tree\nowners: [alice]\n---\n# Example Tree\n",
  );
  writeFileSync(
    join(
      skillRoot,
      "assets",
      "framework",
      "templates",
      AGENT_INSTRUCTIONS_TEMPLATE,
    ),
    "<!-- BEGIN CONTEXT-TREE FRAMEWORK -->\nframework text\n<!-- END CONTEXT-TREE FRAMEWORK -->\n",
  );
  writeFileSync(
    join(
      skillRoot,
      "assets",
      "framework",
      "templates",
      CLAUDE_INSTRUCTIONS_TEMPLATE,
    ),
    "<!-- BEGIN CONTEXT-TREE FRAMEWORK -->\nframework text\n<!-- END CONTEXT-TREE FRAMEWORK -->\n",
  );
  writeFileSync(
    join(
      skillRoot,
      "assets",
      "framework",
      "templates",
      "members-domain.md.template",
    ),
    "---\ntitle: Members\nowners: [alice]\n---\n# Members\n",
  );
  writeFileSync(
    join(
      skillRoot,
      "assets",
      "framework",
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
