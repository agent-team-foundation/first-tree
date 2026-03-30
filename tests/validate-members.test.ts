import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractScalar,
  extractList,
  validateMember,
} from "#src/validators/members.js";
import { useTmpDir } from "./helpers.js";

function write(root: string, relPath: string, content: string): string {
  const p = join(root, relPath);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
  return p;
}

const VALID_MEMBER = `---
title: Alice
owners: [alice]
type: human
role: Engineer
domains: [engineering]
---
# Alice
`;

// --- validateMember ---

describe("validateMember", () => {
  it("accepts valid member", () => {
    const tmp = useTmpDir();
    const p = write(tmp.path, "members/alice/NODE.md", VALID_MEMBER);
    expect(validateMember(p, tmp.path)).toEqual([]);
  });

  it("reports missing title", () => {
    const tmp = useTmpDir();
    const content = "---\nowners: [alice]\ntype: human\nrole: Eng\ndomains: [eng]\n---\n";
    const p = write(tmp.path, "members/alice/NODE.md", content);
    const errors = validateMember(p, tmp.path);
    expect(errors.some((e) => e.includes("title"))).toBe(true);
  });

  it("reports missing type", () => {
    const tmp = useTmpDir();
    const content = "---\ntitle: Alice\nowners: [alice]\nrole: Eng\ndomains: [eng]\n---\n";
    const p = write(tmp.path, "members/alice/NODE.md", content);
    const errors = validateMember(p, tmp.path);
    expect(errors.some((e) => e.includes("type"))).toBe(true);
  });

  it("reports invalid type", () => {
    const tmp = useTmpDir();
    const content = "---\ntitle: Alice\nowners: [alice]\ntype: robot\nrole: Eng\ndomains: [eng]\n---\n";
    const p = write(tmp.path, "members/alice/NODE.md", content);
    const errors = validateMember(p, tmp.path);
    expect(errors.some((e) => e.includes("invalid type"))).toBe(true);
  });

  it("reports missing domains", () => {
    const tmp = useTmpDir();
    const content = "---\ntitle: Alice\nowners: [alice]\ntype: human\nrole: Eng\n---\n";
    const p = write(tmp.path, "members/alice/NODE.md", content);
    const errors = validateMember(p, tmp.path);
    expect(errors.some((e) => e.includes("domains"))).toBe(true);
  });
});

// --- extractScalar ---

describe("extractScalar", () => {
  it("extracts regular value", () => {
    expect(extractScalar("title: Hello World\nowners: [a]", "title")).toBe("Hello World");
  });

  it("extracts quoted value", () => {
    expect(extractScalar('title: "Hello World"\nowners: [a]', "title")).toBe("Hello World");
  });

  it("returns null for missing key", () => {
    expect(extractScalar("owners: [a]", "title")).toBeNull();
  });
});

// --- extractList ---

describe("extractList", () => {
  it("extracts inline list", () => {
    expect(extractList("domains: [eng, product]", "domains")).toEqual(["eng", "product"]);
  });

  it("extracts block list", () => {
    expect(extractList("domains:\n  - eng\n  - product\n", "domains")).toEqual(["eng", "product"]);
  });

  it("handles empty list", () => {
    expect(extractList("domains: []", "domains")).toEqual([]);
  });

  it("returns null for missing key", () => {
    expect(extractList("owners: [a]", "domains")).toBeNull();
  });
});
