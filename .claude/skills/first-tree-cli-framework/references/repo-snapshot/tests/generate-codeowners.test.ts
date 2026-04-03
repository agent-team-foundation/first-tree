import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseOwners,
  resolveNodeOwners,
  collectEntries,
  formatOwners,
} from "../.context-tree/generate-codeowners.js";
import { useTmpDir } from "./helpers.js";

function write(root: string, relPath: string, content: string): string {
  const p = join(root, relPath);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
  return p;
}

// --- parseOwners ---

describe("parseOwners", () => {
  it("parses valid owners", () => {
    const tmp = useTmpDir();
    const p = write(tmp.path, "NODE.md", "---\nowners: [alice, bob]\n---\n");
    expect(parseOwners(p)).toEqual(["alice", "bob"]);
  });

  it("handles empty owners", () => {
    const tmp = useTmpDir();
    const p = write(tmp.path, "NODE.md", "---\nowners: []\n---\n");
    expect(parseOwners(p)).toEqual([]);
  });

  it("handles wildcard", () => {
    const tmp = useTmpDir();
    const p = write(tmp.path, "NODE.md", "---\nowners: [*]\n---\n");
    expect(parseOwners(p)).toEqual(["*"]);
  });

  it("returns null for no frontmatter", () => {
    const tmp = useTmpDir();
    const p = write(tmp.path, "NODE.md", "# Just a heading\n");
    expect(parseOwners(p)).toBeNull();
  });
});

// --- resolveNodeOwners ---

describe("resolveNodeOwners", () => {
  it("returns direct owners", () => {
    const tmp = useTmpDir();
    write(tmp.path, "NODE.md", "---\nowners: [root-owner]\n---\n");
    write(tmp.path, "domain/NODE.md", "---\nowners: [domain-owner]\n---\n");
    const cache = new Map<string, string[]>();
    const result = resolveNodeOwners(join(tmp.path, "domain"), tmp.path, cache);
    expect(result).toEqual(["domain-owner"]);
  });

  it("inherits from parent", () => {
    const tmp = useTmpDir();
    write(tmp.path, "NODE.md", "---\nowners: [root-owner]\n---\n");
    write(tmp.path, "domain/NODE.md", "---\nowners: []\n---\n");
    const cache = new Map<string, string[]>();
    const result = resolveNodeOwners(join(tmp.path, "domain"), tmp.path, cache);
    expect(result).toEqual(["root-owner"]);
  });
});

// --- collectEntries ---

describe("collectEntries", () => {
  it("excludes dot-prefixed dirs", () => {
    const tmp = useTmpDir();
    write(tmp.path, "NODE.md", "---\nowners: [root]\n---\n# Root\n");
    write(tmp.path, "domain/NODE.md", "---\nowners: [alice]\n---\n# Domain\n");
    write(tmp.path, ".hidden/NODE.md", "---\nowners: [secret]\n---\n# Hidden\n");
    const entries = collectEntries(tmp.path);
    const patterns = entries.map(([pat]) => pat);
    expect(patterns.some((p) => p.includes("domain"))).toBe(true);
    expect(patterns.some((p) => p.includes(".hidden"))).toBe(false);
  });
});

// --- formatOwners ---

describe("formatOwners", () => {
  it("deduplicates owners", () => {
    expect(formatOwners(["alice", "bob", "alice"])).toBe("@alice @bob");
  });

  it("adds @ prefix", () => {
    expect(formatOwners(["alice"])).toBe("@alice");
  });
});
