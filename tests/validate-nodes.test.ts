import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Findings,
  parseFrontmatter,
  parseSoftLinks,
  validateOwners,
  validateFolders,
  validateEmptyNodes,
  validateTitleMismatch,
  setTreeRoot,
} from "#products/tree/engine/validators/nodes.js";
import { useTmpDir } from "./helpers.js";

function write(root: string, relPath: string, content: string): string {
  const p = join(root, relPath);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
  return p;
}

function setup(tmp: { path: string }): string {
  setTreeRoot(tmp.path);
  return tmp.path;
}

// --- parseFrontmatter ---

describe("parseFrontmatter", () => {
  it("parses valid frontmatter", () => {
    const tmp = useTmpDir();
    const root = setup(tmp);
    const p = write(root, "NODE.md", "---\ntitle: Hello\nowners: [alice]\n---\n# Hello\n");
    const fm = parseFrontmatter(p);
    expect(fm).not.toBeNull();
    expect(fm).toContain("title: Hello");
  });

  it("returns null for missing frontmatter", () => {
    const tmp = useTmpDir();
    const root = setup(tmp);
    const p = write(root, "NODE.md", "# No frontmatter here\n");
    expect(parseFrontmatter(p)).toBeNull();
  });

  it("returns null for malformed frontmatter", () => {
    const tmp = useTmpDir();
    const root = setup(tmp);
    const p = write(root, "NODE.md", "---\ntitle: Oops\nNo closing fence\n");
    expect(parseFrontmatter(p)).toBeNull();
  });
});

// --- parseSoftLinks ---

describe("parseSoftLinks", () => {
  it("parses inline format", () => {
    expect(parseSoftLinks("owners: [alice]\nsoft_links: [/a, /b]")).toEqual(["/a", "/b"]);
  });

  it("parses block format", () => {
    expect(parseSoftLinks("owners: [alice]\nsoft_links:\n  - /x\n  - /y\n")).toEqual(["/x", "/y"]);
  });

  it("handles empty inline", () => {
    expect(parseSoftLinks("owners: [alice]\nsoft_links: []")).toEqual([]);
  });

  it("returns null when missing", () => {
    expect(parseSoftLinks("owners: [alice]")).toBeNull();
  });
});

// --- validateOwners ---

describe("validateOwners", () => {
  it("accepts valid owners", () => {
    const tmp = useTmpDir();
    const root = setup(tmp);
    const p = write(root, "NODE.md", "---\nowners: [alice, bob]\n---\n");
    const fm = parseFrontmatter(p)!;
    const f = new Findings();
    validateOwners(fm, p, f);
    expect(f.errors).toEqual([]);
  });

  it("accepts wildcard", () => {
    const tmp = useTmpDir();
    const root = setup(tmp);
    const p = write(root, "NODE.md", "---\nowners: [*]\n---\n");
    const fm = parseFrontmatter(p)!;
    const f = new Findings();
    validateOwners(fm, p, f);
    expect(f.errors).toEqual([]);
  });

  it("accepts empty inheritance", () => {
    const tmp = useTmpDir();
    const root = setup(tmp);
    const p = write(root, "NODE.md", "---\nowners: []\n---\n");
    const fm = parseFrontmatter(p)!;
    const f = new Findings();
    validateOwners(fm, p, f);
    expect(f.errors).toEqual([]);
  });

  it("rejects invalid username", () => {
    const tmp = useTmpDir();
    const root = setup(tmp);
    const p = write(root, "NODE.md", "---\nowners: [not valid!]\n---\n");
    const fm = parseFrontmatter(p)!;
    const f = new Findings();
    validateOwners(fm, p, f);
    expect(f.errors).toHaveLength(1);
    expect(f.errors[0]).toContain("invalid owner");
  });

  it("rejects mixed wildcard", () => {
    const tmp = useTmpDir();
    const root = setup(tmp);
    const p = write(root, "NODE.md", "---\nowners: [alice, *]\n---\n");
    const fm = parseFrontmatter(p)!;
    const f = new Findings();
    validateOwners(fm, p, f);
    expect(f.errors).toHaveLength(1);
    expect(f.errors[0]).toContain("wildcard");
  });

  it("rejects empty entries between commas", () => {
    const tmp = useTmpDir();
    const root = setup(tmp);
    const p = write(root, "NODE.md", "---\nowners: [alice, , bob]\n---\n");
    const fm = parseFrontmatter(p)!;
    const f = new Findings();
    validateOwners(fm, p, f);
    expect(f.errors).toHaveLength(1);
    expect(f.errors[0]).toContain("empty entry");
  });

  it("accepts trailing comma", () => {
    const tmp = useTmpDir();
    const root = setup(tmp);
    const p = write(root, "NODE.md", "---\nowners: [alice,]\n---\n");
    const fm = parseFrontmatter(p)!;
    const f = new Findings();
    validateOwners(fm, p, f);
    expect(f.errors).toEqual([]);
  });

  it("accepts trailing comma with space", () => {
    const tmp = useTmpDir();
    const root = setup(tmp);
    const p = write(root, "NODE.md", "---\nowners: [alice, bob, ]\n---\n");
    const fm = parseFrontmatter(p)!;
    const f = new Findings();
    validateOwners(fm, p, f);
    expect(f.errors).toEqual([]);
  });
});

// --- validateFolders ---

describe("validateFolders", () => {
  it("reports missing NODE.md", () => {
    const tmp = useTmpDir();
    const root = setup(tmp);
    mkdirSync(join(root, "domain"));
    const f = new Findings();
    validateFolders(f);
    expect(f.errors.some((e) => e.includes("missing NODE.md"))).toBe(true);
  });

  it("passes with valid folder", () => {
    const tmp = useTmpDir();
    const root = setup(tmp);
    mkdirSync(join(root, "domain"));
    writeFileSync(join(root, "domain", "NODE.md"), "---\nowners: [a]\n---\n# D\n");
    const f = new Findings();
    validateFolders(f);
    expect(f.errors).toEqual([]);
  });
});

// --- validateEmptyNodes ---

describe("validateEmptyNodes", () => {
  it("flags short body", () => {
    const tmp = useTmpDir();
    const root = setup(tmp);
    const p = write(root, "NODE.md", "---\nowners: [a]\n---\n\n");
    const f = new Findings();
    validateEmptyNodes([p], f);
    expect(f.warnings.some((w) => w.includes("little or no body content"))).toBe(true);
  });

  it("passes with adequate body", () => {
    const tmp = useTmpDir();
    const root = setup(tmp);
    const body = "This is a meaningful body with enough content to pass the threshold easily.";
    const p = write(root, "NODE.md", `---\nowners: [a]\n---\n${body}\n`);
    const f = new Findings();
    validateEmptyNodes([p], f);
    expect(f.warnings).toEqual([]);
  });
});

// --- validateTitleMismatch ---

describe("validateTitleMismatch", () => {
  it("passes with matching title", () => {
    const tmp = useTmpDir();
    const root = setup(tmp);
    const p = write(root, "NODE.md", "---\ntitle: Hello World\nowners: [a]\n---\n# Hello World\n");
    const f = new Findings();
    validateTitleMismatch([p], f);
    expect(f.warnings).toEqual([]);
  });

  it("flags mismatched title", () => {
    const tmp = useTmpDir();
    const root = setup(tmp);
    const p = write(root, "NODE.md", "---\ntitle: Hello\nowners: [a]\n---\n# Goodbye\n");
    const f = new Findings();
    validateTitleMismatch([p], f);
    expect(f.warnings).toHaveLength(1);
    expect(f.warnings[0]).toContain("differs from");
  });
});
