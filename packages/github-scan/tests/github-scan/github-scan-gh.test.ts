/**
 * GhClient: verifies argv construction and that errors propagate (or
 * are swallowed, per the silent "non-labeler fallback" from spec doc 3 §8).
 * child_process.spawnSync is stubbed.
 */
import type { SpawnSyncReturns } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_GH_MAX_BUFFER_BYTES,
  GhClient,
  GhExecError,
} from "../../src/github-scan/engine/runtime/gh.js";

type SpawnFn = ConstructorParameters<typeof GhClient>[0] extends
  | { spawn?: infer S }
  | undefined
  ? S
  : never;

function stubSuccess(stdout = "", stderr = ""): SpawnFn {
  return vi.fn().mockReturnValue({
    pid: 1,
    status: 0,
    signal: null,
    stdout: Buffer.from(stdout, "utf-8"),
    stderr: Buffer.from(stderr, "utf-8"),
    output: [],
  } satisfies SpawnSyncReturns<Buffer>) as SpawnFn;
}

function stubFailure(status: number, stderr = ""): SpawnFn {
  return vi.fn().mockReturnValue({
    pid: 1,
    status,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.from(stderr, "utf-8"),
    output: [],
  } satisfies SpawnSyncReturns<Buffer>) as SpawnFn;
}

describe("GhClient.run", () => {
  it("passes argv to gh", () => {
    const spawn = stubSuccess("hi");
    const gh = new GhClient({ spawn });
    const result = gh.run(["api", "/user"]);
    expect(spawn).toHaveBeenCalledWith(
      "gh",
      ["api", "/user"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("hi");
  });

  it("captures failure status and stderr without throwing", () => {
    const spawn = stubFailure(1, "nope");
    const gh = new GhClient({ spawn });
    const result = gh.run(["label", "create", "x"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("nope");
  });

  it("binary override is respected", () => {
    const spawn = stubSuccess();
    const gh = new GhClient({ spawn, binary: "/opt/gh" });
    gh.run(["api", "/user"]);
    expect(spawn).toHaveBeenCalledWith(
      "/opt/gh",
      ["api", "/user"],
      expect.anything(),
    );
  });

  it("passes a generous maxBuffer so gh api notifications does not ENOBUFS", () => {
    // Regression: the default spawnSync maxBuffer (~1 MiB) was silently
    // blowing up on accounts with a few hundred open notification threads,
    // because `gh api notifications` returns >1 MiB of JSON. That killed
    // the entire candidate-poll path and degraded the daemon to
    // search-only (which caps candidates at 10/poll).
    const spawn = stubSuccess("[]");
    const gh = new GhClient({ spawn });
    gh.run(["api", "notifications"]);
    expect(spawn).toHaveBeenCalledWith(
      "gh",
      ["api", "notifications"],
      expect.objectContaining({ maxBuffer: DEFAULT_GH_MAX_BUFFER_BYTES }),
    );
    expect(DEFAULT_GH_MAX_BUFFER_BYTES).toBeGreaterThanOrEqual(
      16 * 1024 * 1024,
    );
  });

  it("honors a custom maxBufferBytes override", () => {
    const spawn = stubSuccess();
    const gh = new GhClient({ spawn, maxBufferBytes: 128 });
    gh.run(["api", "/user"]);
    expect(spawn).toHaveBeenCalledWith(
      "gh",
      ["api", "/user"],
      expect.objectContaining({ maxBuffer: 128 }),
    );
  });
});

describe("GhClient.runChecked", () => {
  it("returns stdout on success", () => {
    const spawn = stubSuccess("ok");
    const gh = new GhClient({ spawn });
    expect(gh.runChecked("test", ["api", "/user"])).toBe("ok");
  });
  it("throws GhExecError on failure", () => {
    const spawn = stubFailure(2, "bad request");
    const gh = new GhClient({ spawn });
    expect(() => gh.runChecked("fetch user", ["api", "/user"])).toThrow(GhExecError);
  });
});

describe("GhClient.removeLabel", () => {
  it("uses `gh issue edit --remove-label`", () => {
    const spawn = stubSuccess();
    const gh = new GhClient({ spawn });
    gh.removeLabel("owner/repo", 42, "github-scan:wip");
    expect(spawn).toHaveBeenCalledWith(
      "gh",
      [
        "issue",
        "edit",
        "42",
        "--repo",
        "owner/repo",
        "--remove-label",
        "github-scan:wip",
      ],
      expect.anything(),
    );
  });

  it("swallows failure (non-existent label etc.)", () => {
    const spawn = stubFailure(1, "no such label");
    const gh = new GhClient({ spawn });
    expect(() => gh.removeLabel("owner/repo", 42, "github-scan:wip")).not.toThrow();
  });
});

describe("GhClient.addLabelWithFallback", () => {
  it("single gh call when label exists on repo", () => {
    const spawn = stubSuccess();
    const gh = new GhClient({ spawn });
    gh.addLabelWithFallback(
      "owner/repo",
      42,
      "github-scan:wip",
      "e4e669",
      "work in progress",
    );
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("falls back to `label create --force` when add fails", () => {
    const calls: string[][] = [];
    const spawn = vi.fn().mockImplementation((_cmd, argv: string[]) => {
      calls.push([...argv]);
      const status = calls.length === 1 ? 1 : 0;
      return {
        pid: 1,
        status,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        output: [],
      } satisfies SpawnSyncReturns<Buffer>;
    }) as SpawnFn;
    const gh = new GhClient({ spawn });
    gh.addLabelWithFallback(
      "owner/repo",
      42,
      "github-scan:wip",
      "e4e669",
      "work in progress",
    );
    // call 1: add-label, call 2: label create, call 3: add-label retry.
    expect(calls.length).toBe(3);
    expect(calls[0][5]).toBe("--add-label");
    expect(calls[1][0]).toBe("label");
    expect(calls[1][1]).toBe("create");
    expect(calls[2][5]).toBe("--add-label");
  });
});

describe("GhClient.createLabel", () => {
  it("forwards color and description with --force", () => {
    const spawn = stubSuccess();
    const gh = new GhClient({ spawn });
    gh.createLabel("owner/repo", "github-scan:new", "0075ca", "GitHub Scan: new notification");
    expect(spawn).toHaveBeenCalledWith(
      "gh",
      [
        "label",
        "create",
        "github-scan:new",
        "--repo",
        "owner/repo",
        "--color",
        "0075ca",
        "--description",
        "GitHub Scan: new notification",
        "--force",
      ],
      expect.anything(),
    );
  });
});
