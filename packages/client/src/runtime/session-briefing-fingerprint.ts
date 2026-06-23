// Per-(SDK)session fingerprint of the briefing the agent was last told in a
// turn. The shared briefing (`<cwd>/AGENTS.md`, symlinked to `CLAUDE.md`) is
// rewritten on every session start / resume, and the Claude Code SDK reloads
// it via `settingSources: ["project"]` on query construction — yet a *resumed*
// session carries a transcript built under the PREVIOUS briefing. When a
// runtime upgrade changes the briefing (e.g. a communication-contract change),
// the resumed agent keeps acting on the stale instructions its transcript
// established, because the freshly-read briefing is not salient against the
// established behavior.
//
// This module lets `resume()` detect that case: it records a fingerprint of
// the briefing each turn ran with, keyed by SDK session id, and compares on
// the next resume. A mismatch (or a missing baseline — a session that predates
// this mechanism) is the signal to surface a one-time re-read notice into the
// resumed turn.
//
// Scope / placement: one tiny JSON file per session under the agent home's
// `.first-tree-workspace/` runtime dir. Per-session files (rather than one
// shared map) are deliberate — the agent home is SHARED by every chat of the
// same agent, so a single map would race between sibling-chat sessions; each
// session only ever writes its own file.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The per-agent runtime directory name. Inlined as a literal (rather than
 * imported from `bootstrap.ts`) to avoid an import cycle — same convention
 * `managed-state.ts` follows. Keep in sync with the source of truth in
 * `bootstrap.ts` (`FIRST_TREE_RUNTIME_DIR`).
 */
const RUNTIME_DIR = ".first-tree-workspace";

/** Subdirectory holding the per-session briefing fingerprints. */
export const SESSION_BRIEFINGS_DIR_REL = join(RUNTIME_DIR, "session-briefings");

/**
 * Stable content fingerprint of a rendered briefing. The whole briefing is
 * hashed: it is cache-friendly / stable across resumes for the same config and
 * runtime version (per-chat Current Chat Context is NOT part of it), so the
 * hash changes exactly when something the agent reads changes — a prompt-stack
 * edit, identity / source-repo / tree-binding change, a skill set change, or a
 * runtime template change between CLI versions (the upgrade case this targets).
 */
export function computeBriefingFingerprint(briefing: string): string {
  return createHash("sha256").update(briefing, "utf8").digest("hex");
}

function sessionFingerprintPath(workspacePath: string, sessionId: string): string {
  return join(workspacePath, SESSION_BRIEFINGS_DIR_REL, `${sessionId}.json`);
}

type SessionBriefingRecord = {
  schemaVersion: 1;
  fingerprint: string;
};

/**
 * Read the fingerprint recorded for `sessionId`, or `null` when none exists
 * (first run on this mechanism, unreadable, malformed, or a future schema).
 * Callers treat `null` as "baseline unknown".
 */
export function readSessionBriefingFingerprint(workspacePath: string, sessionId: string): string | null {
  const path = sessionFingerprintPath(workspacePath, sessionId);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== 1) return null;
  return typeof record.fingerprint === "string" ? record.fingerprint : null;
}

/**
 * Record the briefing fingerprint for `sessionId`. Atomic (temp + rename) so a
 * concurrent reader never sees a half-written file. Best-effort: never throws —
 * a fingerprint write failure must not take down the session.
 */
export function writeSessionBriefingFingerprint(workspacePath: string, sessionId: string, fingerprint: string): void {
  try {
    const dir = join(workspacePath, SESSION_BRIEFINGS_DIR_REL);
    mkdirSync(dir, { recursive: true });
    const record: SessionBriefingRecord = { schemaVersion: 1, fingerprint };
    const finalPath = sessionFingerprintPath(workspacePath, sessionId);
    const tmpPath = join(dir, `.${sessionId}.${randomBytes(6).toString("hex")}.tmp`);
    writeFileSync(tmpPath, JSON.stringify(record), "utf-8");
    renameSync(tmpPath, finalPath);
  } catch {
    // best-effort; the worst case is a redundant re-read notice next resume.
  }
}

/**
 * The one-time re-read notice prepended to a resumed turn when the briefing
 * fingerprint changed since the session last ran. Kept pure/exported so the
 * exact wording is unit-testable.
 */
export function buildBriefingUpdateNotice(claudeMdPath: string): string {
  return [
    "<system-reminder>",
    "Your workspace operating instructions (CLAUDE.md / AGENTS.md) and/or the " +
      "skills installed for you have changed since this conversation last ran — " +
      "most likely a First Tree runtime upgrade rewrote the briefing or the skill set. " +
      "The earlier turns in this conversation were produced under the PREVIOUS " +
      "instructions and may now be stale.",
    `Before acting on the message below, re-read your instructions at ${claudeMdPath} ` +
      "and follow the current contract. Pay particular attention to anything about how " +
      "you communicate — especially how you reply to a human (the way to deliver a " +
      "human-visible reply may have changed).",
    "This notice is shown once per update.",
    "</system-reminder>",
  ].join("\n");
}
