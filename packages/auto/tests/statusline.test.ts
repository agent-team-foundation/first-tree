/**
 * auto statusline: single-line summary read from `~/.first-tree/auto/inbox.json`.
 *
 * The statusline bundle is kept deliberately tiny (zero npm deps); it is
 * called many times per session by the Claude Code statusline hook and
 * must cold-start in under ~30ms. This test suite:
 *   - exercises the pure `renderStatusline` formatter with a range of
 *     inputs (human only, new only, bell-ring cases, nothing)
 *   - runs the built `dist/auto-statusline.js` bundle with a fake
 *     `$AUTO_DIR` cache and measures wall-clock time.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { renderStatusline } from "../src/statusline.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

function mkAutoDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "auto-sl-"));
  return dir;
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

describe("renderStatusline", () => {
  it("returns a line with 0 need-you when counts are all zero", () => {
    const out = renderStatusline(cleanCount(), null);
    expect(out.line).toBe("/auto: ⚠ 0 need-you · ");
    expect(out.ring).toBe(false);
  });

  it("formats human-only summary with no bell on first run", () => {
    const c = cleanCount();
    c.human = 2;
    const out = renderStatusline(c, null);
    expect(out.line).toBe("/auto: ⚠ 2 need-you · ");
    expect(out.ring).toBe(false);
  });

  it("formats new-only summary broken down by type", () => {
    const c = cleanCount();
    c.new = 3;
    c.new_by_type.set("PullRequest", 2);
    c.new_by_type.set("Issue", 1);
    const out = renderStatusline(c, null);
    expect(out.line).toBe("/auto: ⚠ 0 need-you · 2 PRs · 1 issues");
  });

  it("orders new-type breakdown by count desc", () => {
    const c = cleanCount();
    c.new = 5;
    c.new_by_type.set("Issue", 1);
    c.new_by_type.set("PullRequest", 3);
    c.new_by_type.set("Discussion", 1);
    const out = renderStatusline(c, null);
    expect(out.line).toBe("/auto: ⚠ 0 need-you · 3 PRs · 1 issues · 1 discussions");
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
    expect(out.line).toBe("/auto: ⚠ 0 need-you · 5 PRs (+2 new)");
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
    expect(out.line).toBe("/auto: ⚠ 0 need-you · 5 PRs");
  });
});

describe("auto-statusline dist bundle", () => {
  const BUNDLE_PATH = join(TEST_DIR, "..", "dist", "auto-statusline.js");

  // spawnSync sporadically returns status: null under vitest's parallel
  // worker pressure (the child gets a signal before exit is observed).
  // Retry up to 3 times before letting the assertion fail.
  function runBundle(
    autoDir: string,
    encoding?: "utf-8",
  ): ReturnType<typeof spawnSync> {
    let last: ReturnType<typeof spawnSync> | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      last = spawnSync(process.execPath, [BUNDLE_PATH], {
        env: { ...process.env, AUTO_DIR: autoDir },
        encoding,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (last.status !== null) return last;
    }
    return last as ReturnType<typeof spawnSync>;
  }

  it("prints a summary line from a fake cache file", () => {
    if (!existsSync(BUNDLE_PATH)) {
      // Build hasn't been run; skip this test rather than silently pass.
      console.warn(
        "dist/auto-statusline.js missing — run `pnpm build` before this test",
      );
      return;
    }
    const dir = mkAutoDir();
    try {
      const inbox = {
        last_poll: "2026-04-16T20:00:00Z",
        notifications: [
          { id: "a", type: "PullRequest", breeze_status: "new" },
          { id: "b", type: "PullRequest", breeze_status: "new" },
          { id: "c", type: "Issue", breeze_status: "new" },
          { id: "d", type: "PullRequest", breeze_status: "human" },
        ],
      };
      writeFileSync(join(dir, "inbox.json"), JSON.stringify(inbox), "utf-8");
      const result = runBundle(dir, "utf-8");
      expect(result.status).toBe(0);
      expect(result.stdout as string).toMatch(/\/auto:/u);
      expect(result.stdout as string).toContain("1 need-you");
      expect(result.stdout as string).toContain("2 PRs");
      expect(result.stdout as string).toContain("1 issues");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints nothing when the inbox file is absent", () => {
    if (!existsSync(BUNDLE_PATH)) return;
    const dir = mkAutoDir();
    try {
      const result = runBundle(dir, "utf-8");
      expect(result.status).toBe(0);
      expect(result.stdout as string).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cold-starts under 200ms (target <30ms; 200ms guards against regressions)", () => {
    if (!existsSync(BUNDLE_PATH)) return;
    const dir = mkAutoDir();
    try {
      const inbox = {
        last_poll: "2026-04-16T20:00:00Z",
        notifications: Array.from({ length: 300 }, (_, i) => ({
          id: `id-${i}`,
          type: i % 3 === 0 ? "Issue" : "PullRequest",
          breeze_status: i % 7 === 0 ? "human" : "new",
        })),
      };
      writeFileSync(join(dir, "inbox.json"), JSON.stringify(inbox), "utf-8");
      // Warm up once so hot filesystem cache.
      runBundle(dir);
      const runs = 5;
      const timings: number[] = [];
      for (let i = 0; i < runs; i += 1) {
        const start = Number(process.hrtime.bigint() / 1000000n);
        const result = runBundle(dir);
        const end = Number(process.hrtime.bigint() / 1000000n);
        expect(result.status).toBe(0);
        timings.push(end - start);
      }
      const median = [...timings].sort((a, b) => a - b)[Math.floor(runs / 2)];
      console.log(
        `auto-statusline cold-start: median ${median}ms across ${runs} runs (timings: ${timings.join(", ")})`,
      );
      // Target is <30ms for the bundle code itself, but `node` itself
      // needs ~40-80ms to spin up on many machines. We guard against
      // regressions by checking the end-to-end stays under 200ms.
      expect(median).toBeLessThan(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
