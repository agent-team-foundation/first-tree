import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isValidManagedSkillName,
  MANAGED_STATE_REL,
  type ManagedState,
  readManagedState,
  updateManagedState,
  writeManagedState,
} from "../runtime/managed-state.js";

const OFFICIAL_MANAGED_SKILL_NAMES = [
  "attention",
  "context-tree-audit",
  "context-tree-review",
  "first-tree",
  "first-tree-cloud",
  "first-tree-context",
  "first-tree-file-bug",
  "first-tree-github",
  "first-tree-github-scan",
  "first-tree-gitlab",
  "first-tree-guide",
  "first-tree-hub-cli",
  "first-tree-kickoff",
  "first-tree-onboarding",
  "first-tree-qa",
  "first-tree-read",
  "first-tree-seed",
  "first-tree-sync",
  "first-tree-welcome",
  "first-tree-write",
  "github-scan",
] as const;

const INVALID_MANAGED_SKILL_NAMES: ReadonlyArray<[label: string, value: string]> = [
  ["empty", ""],
  ["space", " "],
  ["leading whitespace", " first-tree-read"],
  ["trailing whitespace", "first-tree-read "],
  ["current directory", "."],
  ["parent directory", ".."],
  ["traversal", "../outside"],
  ["multi-level traversal", "../../outside"],
  ["normalized traversal", "safe/../../outside"],
  ["Windows traversal", "safe\\..\\..\\outside"],
  ["forward slash", "nested/skill"],
  ["backslash", "nested\\skill"],
  ["POSIX absolute", "/tmp/managed-skill"],
  ["Windows drive root", "C:"],
  ["Windows drive-relative", "C:managed-skill"],
  ["Windows drive absolute", "C:\\temp\\managed-skill"],
  ["Windows slash absolute", "C:/temp/managed-skill"],
  ["Windows root-relative", "\\temp\\managed-skill"],
  ["UNC", "\\\\server\\share\\managed-skill"],
  ["Windows device namespace", "\\\\?\\C:\\temp\\managed-skill"],
  ["Windows device path", "\\\\.\\pipe\\managed-skill"],
  ["NUL", "skill\0name"],
  ["tab", "skill\tname"],
  ["newline", "skill\nname"],
  ["DEL", "skill\u007fname"],
  ["non-ASCII", "技能"],
  ["accented non-ASCII", "café"],
  ["Unicode hyphen homoglyph", "first‐tree"],
  ["uppercase", "First-Tree"],
  ["underscore", "first_tree"],
  ["leading hyphen", "-first-tree"],
  ["trailing hyphen", "first-tree-"],
  ["repeated hyphen", "first--tree"],
  ["over 64 characters", "a".repeat(65)],
];

describe("isValidManagedSkillName", () => {
  it.each([
    ...OFFICIAL_MANAGED_SKILL_NAMES,
    "a",
    "1",
    "skill-2",
    "a".repeat(64),
  ])("accepts the compatible managed slug %s", (name) => {
    expect(isValidManagedSkillName(name)).toBe(true);
  });

  it.each(INVALID_MANAGED_SKILL_NAMES)("rejects %s", (_label, name) => {
    expect(isValidManagedSkillName(name)).toBe(false);
  });
});

describe("managed-state", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "managed-state-test-"));
    mkdirSync(join(workspace, ".first-tree-workspace"), { recursive: true });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("returns null when the state file does not exist", () => {
    expect(readManagedState(workspace)).toBeNull();
  });

  it("round-trips a written record verbatim", () => {
    const state: ManagedState = {
      schemaVersion: 1,
      cliVersion: "0.3.2",
      updatedAt: "2026-06-08T16:00:00.000Z",
      skills: ["first-tree-write", "first-tree-read", "first-tree-seed"],
    };
    writeManagedState(workspace, state);
    expect(readManagedState(workspace)).toEqual(state);
  });

  it("returns null on malformed JSON", () => {
    writeFileSync(join(workspace, MANAGED_STATE_REL), "{not json", "utf-8");
    expect(readManagedState(workspace)).toBeNull();
  });

  it("returns null when schemaVersion is not 1", () => {
    writeFileSync(join(workspace, MANAGED_STATE_REL), JSON.stringify({ schemaVersion: 2, skills: [] }), "utf-8");
    expect(readManagedState(workspace)).toBeNull();
  });

  it("returns null when the record is not an object", () => {
    writeFileSync(join(workspace, MANAGED_STATE_REL), "null", "utf-8");
    expect(readManagedState(workspace)).toBeNull();
  });

  it("normalizes invalid optional metadata while preserving valid skills", () => {
    writeFileSync(
      join(workspace, MANAGED_STATE_REL),
      JSON.stringify({
        schemaVersion: 1,
        cliVersion: 42,
        updatedAt: false,
        skills: ["first-tree-write"],
      }),
      "utf-8",
    );

    expect(readManagedState(workspace)).toEqual({
      schemaVersion: 1,
      cliVersion: null,
      updatedAt: "1970-01-01T00:00:00.000Z",
      skills: ["first-tree-write"],
    });
  });

  it("filters non-string entries out of the skills array (defensive read)", () => {
    writeFileSync(
      join(workspace, MANAGED_STATE_REL),
      JSON.stringify({
        schemaVersion: 1,
        cliVersion: null,
        updatedAt: "2026-06-08T16:00:00.000Z",
        // Intentionally garbage entries to confirm the read filter:
        skills: ["first-tree-write", 42, null, "first-tree-read"],
      }),
      "utf-8",
    );
    expect(readManagedState(workspace)?.skills).toEqual(["first-tree-write", "first-tree-read"]);
  });

  it("filters invalid skill names while preserving valid order and duplicates", () => {
    writeFileSync(
      join(workspace, MANAGED_STATE_REL),
      JSON.stringify({
        schemaVersion: 1,
        cliVersion: null,
        updatedAt: "2026-06-08T16:00:00.000Z",
        skills: [
          "first-tree-write",
          "../outside",
          "first-tree-read",
          "first-tree-write",
          "C:outside",
          "first-tree-read",
        ],
      }),
      "utf-8",
    );

    expect(readManagedState(workspace)?.skills).toEqual([
      "first-tree-write",
      "first-tree-read",
      "first-tree-write",
      "first-tree-read",
    ]);
  });

  it("coerces a non-array skills value to [] (defensive read)", () => {
    writeFileSync(
      join(workspace, MANAGED_STATE_REL),
      JSON.stringify({
        schemaVersion: 1,
        cliVersion: null,
        updatedAt: "2026-06-08T16:00:00.000Z",
        skills: "not-an-array",
      }),
      "utf-8",
    );
    expect(readManagedState(workspace)?.skills).toEqual([]);
  });

  it("updateManagedState applies the mutator and persists the result", () => {
    const result = updateManagedState(workspace, "1.2.3", (current) => ({
      ...current,
      skills: ["alpha", "beta"],
    }));
    expect(result.skills).toEqual(["alpha", "beta"]);
    expect(result.cliVersion).toBe("1.2.3");
    expect(result.schemaVersion).toBe(1);

    const readBack = readManagedState(workspace);
    expect(readBack?.skills).toEqual(["alpha", "beta"]);
    expect(readBack?.cliVersion).toBe("1.2.3");
  });

  it("updateManagedState preserves skills across a later no-op update", () => {
    updateManagedState(workspace, "1.2.3", (current) => ({
      ...current,
      skills: ["first-tree-write", "first-tree-read"],
    }));
    updateManagedState(workspace, "1.2.3", (current) => current);
    const final = readManagedState(workspace);
    expect(final?.skills).toEqual(["first-tree-write", "first-tree-read"]);
    expect(final?.cliVersion).toBe("1.2.3");
  });

  it("updateManagedState refreshes updatedAt on every call", async () => {
    const first = updateManagedState(workspace, null, (current) => ({
      ...current,
      skills: ["alpha"],
    }));
    // Sleep a hair so the ISO timestamps differ even on fast machines.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = updateManagedState(workspace, null, (current) => current);
    expect(second.updatedAt).not.toBe(first.updatedAt);
    expect(new Date(second.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(first.updatedAt).getTime());
  });

  it("writeManagedState produces atomic writes (no leftover temp siblings)", () => {
    const state: ManagedState = {
      schemaVersion: 1,
      cliVersion: null,
      updatedAt: new Date().toISOString(),
      skills: [],
    };
    writeManagedState(workspace, state);
    // The directory should contain only the final file, no `.tmp` siblings.
    const agentDir = join(workspace, ".first-tree-workspace");
    const entries = readdirSync(agentDir);
    expect(entries.filter((entry) => entry.includes(".tmp"))).toEqual([]);
    expect(entries).toContain("managed.json");
  });

  it("writeManagedState content is JSON-pretty with trailing newline (POSIX-friendly)", () => {
    writeManagedState(workspace, {
      schemaVersion: 1,
      cliVersion: "x",
      updatedAt: "y",
      skills: [],
    });
    const raw = readFileSync(join(workspace, MANAGED_STATE_REL), "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    // Pretty-printed: indented entries should be present.
    expect(raw).toContain('  "schemaVersion"');
  });

  it("cleans up the temp file when the atomic rename fails", () => {
    mkdirSync(join(workspace, MANAGED_STATE_REL), { recursive: true });

    expect(() =>
      writeManagedState(workspace, {
        schemaVersion: 1,
        cliVersion: null,
        updatedAt: "2026-06-08T16:00:00.000Z",
        skills: [],
      }),
    ).toThrow();

    const agentDir = join(workspace, ".first-tree-workspace");
    expect(readdirSync(agentDir).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });
});
