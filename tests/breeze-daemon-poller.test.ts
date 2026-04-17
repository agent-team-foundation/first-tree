/**
 * Parity tests for the Phase 3a TS daemon poller.
 *
 * Covers:
 *   - `pollOnce` transforms a single notification into an inbox entry
 *     that matches the canonical shape from
 *     the inbox/activity-log schema (historical migration doc, now removed; see git history) §1.2.
 *   - `isRateLimited` classifier recognises the same signatures as
 *     `gh_executor.rs::is_rate_limited`.
 *   - `rateLimitBackoffMs` follows the Rust exponential schedule.
 *   - `runPoller` loop exits cleanly on AbortSignal.
 */

import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GhClient } from "../src/products/breeze/engine/runtime/gh.js";
import { resolveBreezePaths } from "../src/products/breeze/engine/runtime/paths.js";
import {
  isRateLimited,
  pollOnce,
  rateLimitBackoffMs,
  runPoller,
} from "../src/products/breeze/engine/daemon/poller.js";

interface ResponseMatcher {
  match: (argv: readonly string[]) => boolean;
  status?: number;
  stdout?: string;
  stderr?: string;
}

function makeStubGh(matchers: ResponseMatcher[]): GhClient {
  const calls: string[][] = [];
  const spawn = vi
    .fn()
    .mockImplementation((_cmd: string, argv: string[]) => {
      calls.push([...argv]);
      for (const m of matchers) {
        if (m.match(argv)) {
          return {
            pid: 1,
            status: m.status ?? 0,
            signal: null,
            stdout: Buffer.from(m.stdout ?? ""),
            stderr: Buffer.from(m.stderr ?? ""),
            output: [],
          };
        }
      }
      return {
        pid: 1,
        status: 0,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        output: [],
      };
    });
  return new GhClient({ spawn });
}

function mkBreezeDir(): { dir: string; inbox: string; activity: string } {
  const dir = mkdtempSync(join(tmpdir(), "breeze-daemon-poller-"));
  return {
    dir,
    inbox: join(dir, "inbox.json"),
    activity: join(dir, "activity.log"),
  };
}

describe("isRateLimited", () => {
  it("recognises the same signatures as the Rust helper", () => {
    expect(isRateLimited("", "API rate limit exceeded (HTTP 403)")).toBe(true);
    expect(isRateLimited("", "secondary rate limit for user")).toBe(true);
    expect(isRateLimited("", "abuse detection triggered")).toBe(true);
    expect(isRateLimited("", "please retry after 60s")).toBe(true);
    expect(isRateLimited("", "gh: permission denied")).toBe(false);
    expect(isRateLimited("", "")).toBe(false);
  });
});

describe("rateLimitBackoffMs", () => {
  it("starts at 120s (2^1 * 60s) on first strike", () => {
    expect(rateLimitBackoffMs(1)).toBe(120_000);
  });
  it("doubles per consecutive strike, capped at 2^4 * 60s = 960s", () => {
    expect(rateLimitBackoffMs(2)).toBe(240_000);
    expect(rateLimitBackoffMs(3)).toBe(480_000);
    expect(rateLimitBackoffMs(4)).toBe(960_000);
    expect(rateLimitBackoffMs(5)).toBe(960_000);
    expect(rateLimitBackoffMs(100)).toBe(960_000);
  });
  it("clamps streak values below 1 to the initial backoff", () => {
    expect(rateLimitBackoffMs(0)).toBe(120_000);
    expect(rateLimitBackoffMs(-5)).toBe(120_000);
  });
});

describe("pollOnce parity with Rust fetcher", () => {
  let ctx: ReturnType<typeof mkBreezeDir>;
  beforeEach(() => {
    ctx = mkBreezeDir();
  });
  afterEach(() => rmSync(ctx.dir, { recursive: true, force: true }));

  it("writes an inbox.json whose single entry matches the canonical schema", async () => {
    // Canonical shape (redacted) copied from the inbox schema migration doc §1.2:
    //   {
    //     "id": "23576674030",
    //     "type": "PullRequest",
    //     "reason": "author",
    //     "repo": "serenakeyitan/paperclip-tree",
    //     "title": "fix(tree): salvage nya1 member node from closed sync PR 282",
    //     "url": "https://api.github.com/.../pulls/290",
    //     "last_actor": "https://api.github.com/.../issues/comments/4258143984",
    //     "updated_at": "2026-04-16T07:24:28Z",
    //     "unread": false,
    //     "priority": 5,
    //     "number": 290,
    //     "html_url": "https://github.com/.../pull/290",
    //     "gh_state": "OPEN",
    //     "labels": [],
    //     "breeze_status": "new"
    //   }
    const rawNotification = JSON.stringify([
      {
        id: "23576674030",
        subject: {
          type: "PullRequest",
          title: "fix(tree): salvage nya1 member node from closed sync PR 282",
          url: "https://api.github.com/repos/serenakeyitan/paperclip-tree/pulls/290",
          latest_comment_url:
            "https://api.github.com/repos/serenakeyitan/paperclip-tree/issues/comments/4258143984",
        },
        repository: { full_name: "serenakeyitan/paperclip-tree" },
        reason: "author",
        updated_at: "2026-04-16T07:24:28Z",
        unread: false,
      },
    ]);
    const graphqlResponse = JSON.stringify({
      data: {
        repository: {
          n290: {
            number: 290,
            state: "OPEN",
            labels: { nodes: [] },
          },
        },
      },
    });
    const gh = makeStubGh([
      {
        match: (argv) => argv[0] === "api" && argv[1]?.startsWith("/notifications"),
        stdout: rawNotification,
      },
      {
        match: (argv) => argv[0] === "api" && argv[1] === "graphql",
        stdout: graphqlResponse,
      },
    ]);
    const paths = resolveBreezePaths({ env: () => ctx.dir });

    const outcome = await pollOnce({
      gh,
      paths,
      host: "github.com",
      now: () => Date.parse("2026-04-16T20:15:30Z"),
    });

    expect(outcome.total).toBe(1);
    expect(outcome.newCount).toBe(1);
    expect(outcome.warnings).toEqual([]);
    expect(outcome.rateLimited).toBe(false);

    const parsed = JSON.parse(readFileSync(ctx.inbox, "utf-8")) as {
      last_poll: string;
      notifications: Array<Record<string, unknown>>;
    };
    expect(parsed.last_poll).toBe("2026-04-16T20:15:30Z");
    expect(parsed.notifications).toHaveLength(1);

    // Verify every field from the spec matrix, including null fields.
    const entry = parsed.notifications[0];
    expect(entry).toMatchObject({
      id: "23576674030",
      type: "PullRequest",
      reason: "author",
      repo: "serenakeyitan/paperclip-tree",
      title: "fix(tree): salvage nya1 member node from closed sync PR 282",
      url: "https://api.github.com/repos/serenakeyitan/paperclip-tree/pulls/290",
      last_actor:
        "https://api.github.com/repos/serenakeyitan/paperclip-tree/issues/comments/4258143984",
      updated_at: "2026-04-16T07:24:28Z",
      unread: false,
      priority: 5,
      number: 290,
      html_url: "https://github.com/serenakeyitan/paperclip-tree/pull/290",
      gh_state: "OPEN",
      labels: [],
      breeze_status: "new",
    });

    // Key order must match the Rust entry_to_json output (spec §1.1).
    expect(Object.keys(entry)).toEqual([
      "id",
      "type",
      "reason",
      "repo",
      "title",
      "url",
      "last_actor",
      "updated_at",
      "unread",
      "priority",
      "number",
      "html_url",
      "gh_state",
      "labels",
      "breeze_status",
    ]);
  });

  it("marks rateLimited=true when notifications fetch is rate-limited", async () => {
    const gh = makeStubGh([
      {
        match: (argv) =>
          argv[0] === "api" && argv[1]?.startsWith("/notifications"),
        status: 1,
        stderr: "API rate limit exceeded (HTTP 403)",
      },
    ]);
    const paths = resolveBreezePaths({ env: () => ctx.dir });
    const outcome = await pollOnce({
      gh,
      paths,
      host: "github.com",
      now: () => Date.parse("2026-04-16T20:15:30Z"),
    });
    expect(outcome.rateLimited).toBe(true);
    expect(outcome.warnings.length).toBeGreaterThan(0);
  });

  it("emits null for nullable fields (number, gh_state)", async () => {
    const rawNotification = JSON.stringify([
      {
        id: "disc-1",
        subject: { type: "Discussion", title: "chat", url: null },
        repository: { full_name: "o/r" },
        reason: "subscribed",
        updated_at: "2026-04-16T10:00:00Z",
        unread: false,
      },
    ]);
    const gh = makeStubGh([
      {
        match: (argv) =>
          argv[0] === "api" && argv[1]?.startsWith("/notifications"),
        stdout: rawNotification,
      },
    ]);
    const paths = resolveBreezePaths({ env: () => ctx.dir });
    await pollOnce({
      gh,
      paths,
      host: "github.com",
      now: () => Date.parse("2026-04-16T20:00:00Z"),
    });
    const parsed = JSON.parse(readFileSync(ctx.inbox, "utf-8")) as {
      notifications: Array<{ number: unknown; gh_state: unknown }>;
    };
    expect(parsed.notifications[0].number).toBeNull();
    expect(parsed.notifications[0].gh_state).toBeNull();
  });
});

describe("runPoller loop", () => {
  let ctx: ReturnType<typeof mkBreezeDir>;
  beforeEach(() => {
    ctx = mkBreezeDir();
  });
  afterEach(() => rmSync(ctx.dir, { recursive: true, force: true }));

  it("exits cleanly when the AbortSignal fires", async () => {
    const gh = makeStubGh([
      {
        match: (argv) =>
          argv[0] === "api" && argv[1]?.startsWith("/notifications"),
        stdout: "[]",
      },
    ]);
    const paths = resolveBreezePaths({ env: () => ctx.dir });
    const controller = new AbortController();

    // Zero-delay sleep so the loop iterates many times quickly; the signal
    // is the only thing that stops it.
    const sleep = vi.fn().mockImplementation(async (_ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    });

    const logs: string[] = [];
    const logger = {
      info: (line: string) => logs.push(`INFO ${line}`),
      warn: (line: string) => logs.push(`WARN ${line}`),
      error: (line: string) => logs.push(`ERROR ${line}`),
    };

    const runPromise = runPoller({
      pollIntervalSec: 1,
      host: "github.com",
      gh,
      paths,
      signal: controller.signal,
      logger,
      sleep,
    });

    // Let a few iterations go through, then abort.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    controller.abort();

    await expect(runPromise).resolves.toBeUndefined();
    expect(sleep).toHaveBeenCalled();
    // At least one successful poll should have been logged.
    expect(logs.some((l) => l.includes("polled 0 notifications"))).toBe(true);
  });

  it("backs off on rate-limit cycles", async () => {
    // First call is rate-limited; second is ok. Verify the sleep between
    // them matches rateLimitBackoffMs(1) = 120_000.
    let callIdx = 0;
    const spawn = vi.fn().mockImplementation((_cmd: string, argv: string[]) => {
      const isNotifications =
        argv[0] === "api" && argv[1]?.startsWith("/notifications");
      if (!isNotifications) {
        return {
          pid: 1,
          status: 0,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          output: [],
        };
      }
      callIdx += 1;
      if (callIdx === 1) {
        return {
          pid: 1,
          status: 1,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("API rate limit exceeded"),
          output: [],
        };
      }
      return {
        pid: 1,
        status: 0,
        signal: null,
        stdout: Buffer.from("[]"),
        stderr: Buffer.alloc(0),
        output: [],
      };
    });
    const gh = new GhClient({ spawn });
    const paths = resolveBreezePaths({ env: () => ctx.dir });
    const controller = new AbortController();

    const sleepCalls: number[] = [];
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      sleepCalls.push(ms);
      // After the first rate-limit backoff and one success, abort.
      if (sleepCalls.length >= 2) controller.abort();
    });

    await runPoller({
      pollIntervalSec: 1,
      host: "github.com",
      gh,
      paths,
      signal: controller.signal,
      sleep,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    expect(sleepCalls[0]).toBe(120_000); // rate-limit backoff
    expect(sleepCalls[1]).toBe(1000); // normal interval after recovery
  });
});
