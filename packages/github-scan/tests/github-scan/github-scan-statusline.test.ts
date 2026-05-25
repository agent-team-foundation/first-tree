/**
 * github-scan statusline: single-line summary read from `~/.first-tree/github-scan/inbox.json`.
 *
 * The statusline bundle is kept deliberately tiny (zero npm deps); it is
 * called many times per session by the Claude Code statusline hook and
 * must cold-start in under ~30ms. This test suite:
 *   - exercises the pure `renderStatusline` formatter with a range of
 *     inputs (human only, new only, bell-ring cases, nothing)
 *   - runs the built `dist/github-scan-statusline.js` bundle with a fake
 *     `$GITHUB_SCAN_DIR` cache and measures wall-clock time.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { renderStatusline } from "../../src/github-scan/engine/statusline.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = join(TEST_DIR, "..", "..", "dist", "github-scan-statusline.js");
const MAX_EXTRA_COLD_START_MS = 200;

function mkGitHubScanDir(): string {
  return mkdtempSync(join(tmpdir(), "github-scan-sl-"));
}

function cleanCount(): {
  last_poll: string;
  new: number;
  human: number;
  new_by_type: Map<string, number>;
} {
  return {
    last_poll: "2026-04-16T20:00:00Z",
    new: 0,
    human: 0,
    new_by_type: new Map(),
  };
}

function runBundle(githubScanDir: string, encoding?: "utf-8"): ReturnType<typeof spawnSync> {
  let last: ReturnType<typeof spawnSync> | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    last = spawnSync(process.execPath, [BUNDLE_PATH], {
      env: { ...process.env, GITHUB_SCAN_DIR: githubScanDir },
      encoding,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (last.status !== null) return last;
  }
  return last as ReturnType<typeof spawnSync>;
}

function runNoopNode(): ReturnType<typeof spawnSync> {
  let last: ReturnType<typeof spawnSync> | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    last = spawnSync(process.execPath, ["-e", ""], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (last.status !== null) return last;
  }
  return last as ReturnType<typeof spawnSync>;
}

function medianDuration(
  runner: () => ReturnType<typeof spawnSync>,
  runs: number,
): {
  median: number;
  timings: number[];
} {
  const timings: number[] = [];

  for (let i = 0; i < runs; i += 1) {
    const start = Number(process.hrtime.bigint() / 1000000n);
    const result = runner();
    const end = Number(process.hrtime.bigint() / 1000000n);
    expect(result.status).toBe(0);
    timings.push(end - start);
  }

  return {
    median: [...timings].sort((a, b) => a - b)[Math.floor(runs / 2)],
    timings,
  };
}

describe("renderStatusline", () => {
  it("returns a line with 0 need-you when counts are all zero", () => {
    const out = renderStatusline(cleanCount(), null);
    expect(out.line).toBe("/github-scan: ⚠ 0 need-you · ");
    expect(out.ring).toBe(false);
  });

  it("formats human-only summary with no bell on first run", () => {
    const c = cleanCount();
    c.human = 2;
    const out = renderStatusline(c, null);
    expect(out.line).toBe("/github-scan: ⚠ 2 need-you · ");
    expect(out.ring).toBe(false);
  });

  it("formats new-only summary broken down by type", () => {
    const c = cleanCount();
    c.new = 3;
    c.new_by_type.set("PullRequest", 2);
    c.new_by_type.set("Issue", 1);
    const out = renderStatusline(c, null);
    expect(out.line).toBe("/github-scan: ⚠ 0 need-you · 2 PRs · 1 issues");
  });

  it("orders new-type breakdown by count desc", () => {
    const c = cleanCount();
    c.new = 5;
    c.new_by_type.set("Issue", 1);
    c.new_by_type.set("PullRequest", 3);
    c.new_by_type.set("Discussion", 1);
    const out = renderStatusline(c, null);
    expect(out.line).toBe("/github-scan: ⚠ 0 need-you · 3 PRs · 1 issues · 1 discussions");
  });

  it("rings on new-count increase", () => {
    const c = cleanCount();
    c.new = 5;
    c.new_by_type.set("PullRequest", 5);
    const prior = {
      prevPoll: "2026-04-16T19:00:00Z",
      prevNew: 3,
      prevHuman: 0,
    };
    const out = renderStatusline(c, prior);
    expect(out.line).toBe("/github-scan: ⚠ 0 need-you · 5 PRs (+2 new)");
    expect(out.ring).toBe(true);
  });

  it("prefers human ring over new ring when both increased", () => {
    const c = cleanCount();
    c.human = 2;
    c.new = 5;
    c.new_by_type.set("PullRequest", 5);
    const prior = {
      prevPoll: "2026-04-16T19:00:00Z",
      prevNew: 3,
      prevHuman: 1,
    };
    const out = renderStatusline(c, prior);
    expect(out.line).toContain("(+1 need-you)");
    expect(out.ring).toBe(true);
  });

  it("does not ring when the poll timestamp is unchanged", () => {
    const c = cleanCount();
    c.new = 5;
    c.new_by_type.set("PullRequest", 5);
    const prior = {
      prevPoll: c.last_poll,
      prevNew: 3,
      prevHuman: 0,
    };
    const out = renderStatusline(c, prior);
    expect(out.ring).toBe(false);
    expect(out.line).toBe("/github-scan: ⚠ 0 need-you · 5 PRs");
  });
});

describe("github-scan-statusline dist bundle", () => {
  it("prints a summary line from a fake cache file", () => {
    if (!existsSync(BUNDLE_PATH)) {
      console.warn("dist/github-scan-statusline.js missing — run `pnpm build` before this test");
      return;
    }
    const dir = mkGitHubScanDir();
    try {
      const inbox = {
        last_poll: "2026-04-16T20:00:00Z",
        notifications: [
          { id: "a", type: "PullRequest", github_scan_status: "new" },
          { id: "b", type: "PullRequest", github_scan_status: "new" },
          { id: "c", type: "Issue", github_scan_status: "new" },
          { id: "d", type: "PullRequest", github_scan_status: "human" },
        ],
      };
      writeFileSync(join(dir, "inbox.json"), JSON.stringify(inbox), "utf-8");
      const result = runBundle(dir, "utf-8");
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/\/github-scan:/u);
      expect(result.stdout).toContain("1 need-you");
      expect(result.stdout).toContain("2 PRs");
      expect(result.stdout).toContain("1 issues");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints nothing when the inbox file is absent", () => {
    if (!existsSync(BUNDLE_PATH)) return;
    const dir = mkGitHubScanDir();
    try {
      const result = runBundle(dir, "utf-8");
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps bundle cold-start overhead within 200ms of a noop Node process", () => {
    if (!existsSync(BUNDLE_PATH)) return;
    const dir = mkGitHubScanDir();
    try {
      const inbox = {
        last_poll: "2026-04-16T20:00:00Z",
        notifications: Array.from({ length: 300 }, (_, i) => ({
          id: `id-${i}`,
          type: i % 3 === 0 ? "Issue" : "PullRequest",
          github_scan_status: i % 7 === 0 ? "human" : "new",
        })),
      };
      writeFileSync(join(dir, "inbox.json"), JSON.stringify(inbox), "utf-8");
      runNoopNode();
      runBundle(dir);
      const runs = 5;
      const baseline = medianDuration(() => runNoopNode(), runs);
      const bundle = medianDuration(() => runBundle(dir), runs);
      const extraCost = bundle.median - baseline.median;
      console.log(
        `github-scan-statusline cold-start: noop median ${baseline.median}ms (timings: ${baseline.timings.join(", ")}), bundle median ${bundle.median}ms (timings: ${bundle.timings.join(", ")}), extra ${extraCost}ms`,
      );
      expect(extraCost).toBeLessThan(MAX_EXTRA_COLD_START_MS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
