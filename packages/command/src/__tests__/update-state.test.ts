import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isLoopGuarded, readUpdateState, recordUpdateAttempt } from "../core/update-state.js";

describe("update-state", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ftHub-update-state-"));
    path = join(dir, "state", "update-state.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when no state file exists", () => {
    expect(readUpdateState(path)).toBeNull();
  });

  it("records and reads a successful attempt", () => {
    recordUpdateAttempt(
      {
        result: "ok",
        target: "0.14.8",
        currentBefore: "0.14.6",
        installedVersion: "0.14.8",
        reason: null,
        at: "2026-05-20T00:00:00.000Z",
      },
      path,
    );

    const state = readUpdateState(path);
    expect(state).not.toBeNull();
    expect(state?.last.result).toBe("ok");
    expect(state?.last.target).toBe("0.14.8");
    expect(state?.last.installedVersion).toBe("0.14.8");
  });

  it("creates the parent directory on first write", () => {
    expect(existsSync(join(dir, "state"))).toBe(false);
    recordUpdateAttempt(
      {
        result: "failed",
        target: "0.14.9",
        currentBefore: "0.14.8",
        installedVersion: null,
        reason: "npm install -g exited with code 1: EACCES",
        at: "2026-05-20T00:01:00.000Z",
      },
      path,
    );
    expect(existsSync(path)).toBe(true);
  });

  it("overwrites the prior attempt rather than appending", () => {
    recordUpdateAttempt(
      {
        result: "failed",
        target: "0.14.9",
        currentBefore: "0.14.8",
        installedVersion: null,
        reason: "network",
        at: "2026-05-20T00:00:00.000Z",
      },
      path,
    );
    recordUpdateAttempt(
      {
        result: "ok",
        target: "0.14.9",
        currentBefore: "0.14.8",
        installedVersion: "0.14.9",
        reason: null,
        at: "2026-05-20T00:05:00.000Z",
      },
      path,
    );

    const state = readUpdateState(path);
    expect(state?.last.result).toBe("ok");
    expect(state?.last.at).toBe("2026-05-20T00:05:00.000Z");
  });

  it("returns null on a corrupt JSON file rather than throwing", () => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "not json {{{", { mode: 0o600 });
    expect(readUpdateState(path)).toBeNull();
  });

  it("returns null on a schema-incompatible payload", () => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ last: { foo: "bar" } }), { mode: 0o600 });
    expect(readUpdateState(path)).toBeNull();
  });

  describe("isLoopGuarded", () => {
    it("returns false when no state exists", () => {
      expect(isLoopGuarded("0.14.9", path)).toBe(false);
    });

    it("returns false when the last attempt succeeded", () => {
      recordUpdateAttempt(
        {
          result: "ok",
          target: "0.14.9",
          currentBefore: "0.14.8",
          installedVersion: "0.14.9",
          reason: null,
          at: "2026-05-20T00:00:00.000Z",
        },
        path,
      );
      expect(isLoopGuarded("0.14.9", path)).toBe(false);
    });

    it("returns false when the last attempt failed (retryable)", () => {
      // `failed` is npm itself erroring (transient EACCES / network) —
      // the UpdateManager retries on the next welcome and we want it to.
      recordUpdateAttempt(
        {
          result: "failed",
          target: "0.14.9",
          currentBefore: "0.14.8",
          installedVersion: null,
          reason: "EACCES",
          at: "2026-05-20T00:00:00.000Z",
        },
        path,
      );
      expect(isLoopGuarded("0.14.9", path)).toBe(false);
    });

    it("returns true when the last attempt was blocked for the same target", () => {
      recordUpdateAttempt(
        {
          result: "blocked",
          target: "0.14.9",
          currentBefore: "0.14.8",
          installedVersion: "0.14.8",
          reason: "no advance",
          at: "2026-05-20T00:00:00.000Z",
        },
        path,
      );
      expect(isLoopGuarded("0.14.9", path)).toBe(true);
    });

    it("returns false when blocked but for a different target — server moved on", () => {
      // The guard MUST clear automatically once the server advertises a
      // different version; otherwise a single bad rollout would freeze
      // self-update forever even after the operator fixed the dist-tag.
      recordUpdateAttempt(
        {
          result: "blocked",
          target: "0.14.9",
          currentBefore: "0.14.8",
          installedVersion: "0.14.8",
          reason: "no advance",
          at: "2026-05-20T00:00:00.000Z",
        },
        path,
      );
      expect(isLoopGuarded("0.15.0", path)).toBe(false);
    });
  });
});
