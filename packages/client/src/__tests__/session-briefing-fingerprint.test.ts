import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildBriefingUpdateNotice,
  computeBriefingFingerprint,
  readSessionBriefingFingerprint,
  SESSION_BRIEFINGS_DIR_REL,
  writeSessionBriefingFingerprint,
} from "../runtime/session-briefing-fingerprint.js";

const SESSION_ID = "019d9a97-90b0-716b-8317-a8c0be8430d7";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "ftt-briefing-fp-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("computeBriefingFingerprint", () => {
  it("is deterministic for identical content", () => {
    expect(computeBriefingFingerprint("hello briefing")).toBe(computeBriefingFingerprint("hello briefing"));
  });

  it("changes when the briefing content changes", () => {
    expect(computeBriefingFingerprint("v1")).not.toBe(computeBriefingFingerprint("v2"));
  });
});

describe("read/write round-trip", () => {
  it("returns null before any write (unknown baseline)", () => {
    expect(readSessionBriefingFingerprint(workspace, SESSION_ID)).toBeNull();
  });

  it("round-trips a written fingerprint", () => {
    const fp = computeBriefingFingerprint("the briefing");
    writeSessionBriefingFingerprint(workspace, SESSION_ID, fp);
    expect(readSessionBriefingFingerprint(workspace, SESSION_ID)).toBe(fp);
  });

  it("isolates fingerprints per session id (shared agent home, no cross-session bleed)", () => {
    const other = "019d9a97-90b0-716b-8317-aaaaaaaaaaaa";
    writeSessionBriefingFingerprint(workspace, SESSION_ID, computeBriefingFingerprint("a"));
    writeSessionBriefingFingerprint(workspace, other, computeBriefingFingerprint("b"));
    expect(readSessionBriefingFingerprint(workspace, SESSION_ID)).toBe(computeBriefingFingerprint("a"));
    expect(readSessionBriefingFingerprint(workspace, other)).toBe(computeBriefingFingerprint("b"));
  });

  it("overwrites a prior fingerprint for the same session", () => {
    writeSessionBriefingFingerprint(workspace, SESSION_ID, computeBriefingFingerprint("old"));
    writeSessionBriefingFingerprint(workspace, SESSION_ID, computeBriefingFingerprint("new"));
    expect(readSessionBriefingFingerprint(workspace, SESSION_ID)).toBe(computeBriefingFingerprint("new"));
  });
});

describe("readSessionBriefingFingerprint resilience", () => {
  it("returns null on malformed JSON", () => {
    const path = join(workspace, SESSION_BRIEFINGS_DIR_REL, `${SESSION_ID}.json`);
    writeSessionBriefingFingerprint(workspace, SESSION_ID, "seed-so-dir-exists");
    writeFileSync(path, "{not json", "utf-8");
    expect(readSessionBriefingFingerprint(workspace, SESSION_ID)).toBeNull();
  });

  it("returns null for an unknown schema version (future writer)", () => {
    const path = join(workspace, SESSION_BRIEFINGS_DIR_REL, `${SESSION_ID}.json`);
    writeSessionBriefingFingerprint(workspace, SESSION_ID, "seed");
    writeFileSync(path, JSON.stringify({ schemaVersion: 2, fingerprint: "x" }), "utf-8");
    expect(readSessionBriefingFingerprint(workspace, SESSION_ID)).toBeNull();
  });
});

describe("buildBriefingUpdateNotice", () => {
  it("wraps a system-reminder, names the CLAUDE.md path, and flags the comms-contract change", () => {
    const notice = buildBriefingUpdateNotice("/home/agent/CLAUDE.md");
    expect(notice.startsWith("<system-reminder>")).toBe(true);
    expect(notice.trimEnd().endsWith("</system-reminder>")).toBe(true);
    expect(notice).toContain("/home/agent/CLAUDE.md");
    expect(notice).toContain("re-read");
    expect(notice).toContain("reply to a human");
  });
});
