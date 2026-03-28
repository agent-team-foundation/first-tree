import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach } from "vitest";

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

export function makeFramework(root: string): void {
  const ct = join(root, ".context-tree");
  mkdirSync(ct, { recursive: true });
  writeFileSync(join(ct, "VERSION"), "0.1.0\n");
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
