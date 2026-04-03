import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach } from "vitest";
import {
  FRAMEWORK_VERSION,
  LEGACY_VERSION,
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
  mkdirSync(join(root, "skills", "first-tree-cli-framework", "assets", "framework"), {
    recursive: true,
  });
  writeFileSync(join(root, FRAMEWORK_VERSION), `${version}\n`);
}

export function makeLegacyFramework(root: string, version = "0.1.0"): void {
  const ct = join(root, ".context-tree");
  mkdirSync(ct, { recursive: true });
  writeFileSync(join(root, LEGACY_VERSION), `${version}\n`);
}

export function makeSourceSkill(root: string, version = "0.2.0"): void {
  const skillRoot = join(root, "skills", "first-tree-cli-framework");
  mkdirSync(join(skillRoot, "agents"), { recursive: true });
  mkdirSync(join(skillRoot, "assets", "framework", "templates"), {
    recursive: true,
  });

  writeFileSync(
    join(skillRoot, "SKILL.md"),
    "---\nname: first-tree-cli-framework\ndescription: test\n---\n",
  );
  writeFileSync(
    join(skillRoot, "agents", "openai.yaml"),
    "display_name: First Tree CLI Framework\nshort_description: test\n",
  );
  writeFileSync(
    join(skillRoot, "assets", "framework", "manifest.json"),
    "{}\n",
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
      "agent.md.template",
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

export function makeAgentMd(
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
    parts.push("# Agent instructions\n");
  }
  if (userContent) {
    parts.push("\n# Project-specific\nThis is real user content.\n");
  }
  writeFileSync(join(root, "AGENT.md"), parts.join("\n"));
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
