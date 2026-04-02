import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractScalar,
  extractList,
  validateMember,
  runValidateMembers,
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

const VALID_ASSISTANT = `---
title: Alice Assistant
owners: [alice]
type: personal_assistant
role: Assistant
domains: [engineering]
---
# Alice Assistant
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

// --- runValidateMembers: recursive scanning ---

describe("runValidateMembers", () => {
  it("validates nested members recursively", () => {
    const tmp = useTmpDir();
    write(tmp.path, "members/NODE.md", "---\ntitle: Members\n---\n");
    write(tmp.path, "members/alice/NODE.md", VALID_MEMBER);
    write(tmp.path, "members/team-a/NODE.md", `---\ntitle: Team A\nowners: [lead]\ntype: autonomous_agent\nrole: Team Lead\ndomains: [engineering]\n---\n`);
    write(tmp.path, "members/team-a/bot-1/NODE.md", `---\ntitle: Bot 1\nowners: [lead]\ntype: autonomous_agent\nrole: Worker\ndomains: [engineering]\n---\n`);

    const result = runValidateMembers(tmp.path);
    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("detects duplicate directory names across levels", () => {
    const tmp = useTmpDir();
    write(tmp.path, "members/NODE.md", "---\ntitle: Members\n---\n");
    write(tmp.path, "members/alice/NODE.md", VALID_MEMBER);
    // Same name "alice" nested under team-a
    write(tmp.path, "members/team-a/NODE.md", `---\ntitle: Team A\nowners: [lead]\ntype: autonomous_agent\nrole: Lead\ndomains: [eng]\n---\n`);
    write(tmp.path, "members/team-a/alice/NODE.md", `---\ntitle: Alice Clone\nowners: [alice2]\ntype: human\nrole: Eng\ndomains: [eng]\n---\n`);

    const result = runValidateMembers(tmp.path);
    expect(result.exitCode).toBe(1);
    expect(result.errors.some((e) => e.includes("Duplicate member directory name 'alice'"))).toBe(true);
  });

  it("reports missing NODE.md in nested directories", () => {
    const tmp = useTmpDir();
    write(tmp.path, "members/NODE.md", "---\ntitle: Members\n---\n");
    write(tmp.path, "members/alice/NODE.md", VALID_MEMBER);
    // Create directory without NODE.md
    mkdirSync(join(tmp.path, "members/team-a/orphan"), { recursive: true });
    write(tmp.path, "members/team-a/NODE.md", `---\ntitle: Team A\nowners: [lead]\ntype: autonomous_agent\nrole: Lead\ndomains: [eng]\n---\n`);

    const result = runValidateMembers(tmp.path);
    expect(result.exitCode).toBe(1);
    expect(result.errors.some((e) => e.includes("orphan") && e.includes("missing NODE.md"))).toBe(true);
  });

  it("validates deeply nested members (3+ levels)", () => {
    const tmp = useTmpDir();
    write(tmp.path, "members/NODE.md", "---\ntitle: Members\n---\n");
    write(tmp.path, "members/org/NODE.md", `---\ntitle: Org\nowners: [admin]\ntype: autonomous_agent\nrole: Org\ndomains: [all]\n---\n`);
    write(tmp.path, "members/org/team-a/NODE.md", `---\ntitle: Team A\nowners: [lead]\ntype: autonomous_agent\nrole: Lead\ndomains: [eng]\n---\n`);
    write(tmp.path, "members/org/team-a/bot-1/NODE.md", `---\ntitle: Bot 1\nowners: [lead]\ntype: autonomous_agent\nrole: Worker\ndomains: [eng]\n---\n`);

    const result = runValidateMembers(tmp.path);
    expect(result.exitCode).toBe(0);
  });
});

// --- runValidateMembers: delegate_mention cross-validation ---

describe("runValidateMembers delegate_mention", () => {
  it("accepts valid delegate_mention to personal_assistant", () => {
    const tmp = useTmpDir();
    write(tmp.path, "members/NODE.md", "---\ntitle: Members\n---\n");
    write(tmp.path, "members/alice/NODE.md", `---\ntitle: Alice\nowners: [alice]\ntype: human\nrole: Eng\ndomains: [eng]\ndelegate_mention: alice-assistant\n---\n`);
    write(tmp.path, "members/alice-assistant/NODE.md", VALID_ASSISTANT);

    const result = runValidateMembers(tmp.path);
    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("rejects delegate_mention to non-existent member", () => {
    const tmp = useTmpDir();
    write(tmp.path, "members/NODE.md", "---\ntitle: Members\n---\n");
    write(tmp.path, "members/alice/NODE.md", `---\ntitle: Alice\nowners: [alice]\ntype: human\nrole: Eng\ndomains: [eng]\ndelegate_mention: ghost\n---\n`);

    const result = runValidateMembers(tmp.path);
    expect(result.exitCode).toBe(1);
    expect(result.errors.some((e) => e.includes("delegate_mention 'ghost'") && e.includes("non-existent"))).toBe(true);
  });

  it("rejects delegate_mention to non-personal_assistant member", () => {
    const tmp = useTmpDir();
    write(tmp.path, "members/NODE.md", "---\ntitle: Members\n---\n");
    write(tmp.path, "members/alice/NODE.md", `---\ntitle: Alice\nowners: [alice]\ntype: human\nrole: Eng\ndomains: [eng]\ndelegate_mention: bob\n---\n`);
    write(tmp.path, "members/bob/NODE.md", `---\ntitle: Bob\nowners: [bob]\ntype: human\nrole: Eng\ndomains: [eng]\n---\n`);

    const result = runValidateMembers(tmp.path);
    expect(result.exitCode).toBe(1);
    expect(result.errors.some((e) => e.includes("delegate_mention 'bob'") && e.includes("personal_assistant"))).toBe(true);
  });

  it("accepts delegate_mention to nested personal_assistant", () => {
    const tmp = useTmpDir();
    write(tmp.path, "members/NODE.md", "---\ntitle: Members\n---\n");
    write(tmp.path, "members/alice/NODE.md", `---\ntitle: Alice\nowners: [alice]\ntype: human\nrole: Eng\ndomains: [eng]\ndelegate_mention: helper\n---\n`);
    write(tmp.path, "members/bots/NODE.md", `---\ntitle: Bots\nowners: [admin]\ntype: autonomous_agent\nrole: Group\ndomains: [infra]\n---\n`);
    write(tmp.path, "members/bots/helper/NODE.md", `---\ntitle: Helper\nowners: [admin]\ntype: personal_assistant\nrole: Assistant\ndomains: [eng]\n---\n`);

    const result = runValidateMembers(tmp.path);
    expect(result.exitCode).toBe(0);
  });

  it("allows member without delegate_mention", () => {
    const tmp = useTmpDir();
    write(tmp.path, "members/NODE.md", "---\ntitle: Members\n---\n");
    write(tmp.path, "members/alice/NODE.md", VALID_MEMBER);

    const result = runValidateMembers(tmp.path);
    expect(result.exitCode).toBe(0);
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
