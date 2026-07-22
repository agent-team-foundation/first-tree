import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isManagedSkillName,
  MANAGED_STATE_REL,
  type ManagedState,
  readManagedState,
  updateManagedState,
  writeManagedState,
} from "../runtime/managed-state.js";

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

  it("isManagedSkillName accepts current and historical skill slugs", () => {
    for (const name of ["first-tree-write", "context-tree-review", "first-tree-gitlab", "a", "0", "x".repeat(63)]) {
      expect(isManagedSkillName(name)).toBe(true);
    }
  });

  it("isManagedSkillName rejects path-like and malformed names (#1610)", () => {
    for (const name of [
      "..",
      "../..",
      "../../etc",
      "/etc/passwd",
      "a/b",
      "a\\b",
      "C:\\temp",
      "",
      "has space",
      "line\nbreak",
      "nul\u0000byte",
      "Foo",
      "under_score",
      "dot.name",
      "-leading-dash",
      "x".repeat(64),
    ]) {
      expect(isManagedSkillName(name)).toBe(false);
    }
  });

  it("drops invalid skill names on read — the state file is untrusted input (#1610)", () => {
    writeFileSync(
      join(workspace, MANAGED_STATE_REL),
      JSON.stringify({
        schemaVersion: 1,
        cliVersion: null,
        updatedAt: "2026-06-08T16:00:00.000Z",
        skills: ["first-tree-write", "../../outside", "/etc/passwd", "..", "", "has space", "Foo"],
      }),
      "utf-8",
    );
    expect(readManagedState(workspace)?.skills).toEqual(["first-tree-write"]);
  });
});
