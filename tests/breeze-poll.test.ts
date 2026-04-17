/**
 * breeze poll: one-shot notification fetch.
 *
 * `gh` is mocked at the GhClient level — each test provides a canned
 * response queue. We verify:
 *   - auth preflight is honored
 *   - notifications are parsed, sorted, enriched via batched GraphQL,
 *     and classified via the core classifier
 *   - inbox.json is written with the expected shape
 *   - activity.log receives correct `new` / `transition` events
 *   - `new → done` transitions are suppressed (spec §2.2)
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runPoll } from "../src/products/breeze/engine/commands/poll.js";
import { GhClient } from "../src/products/breeze/engine/runtime/gh.js";
import { resolveBreezePaths } from "../src/products/breeze/engine/runtime/paths.js";
import { readActivityLog } from "../src/products/breeze/engine/runtime/activity-log.js";
import {
  parseNotifications,
  sortEntries,
  diffEvents,
  splitConcatenatedJsonArrays,
} from "../src/products/breeze/engine/commands/poll.js";

/**
 * Build a stubbed GhClient. Each call to `spawn` is matched against the
 * first-prefix of the argv — we queue responses by `matcher`.
 */
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
      // Default: empty ok.
      return {
        pid: 1,
        status: 0,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        output: [],
      };
    });
  const gh = new GhClient({ spawn });
  // @ts-expect-error test-only accessor
  gh.__calls = calls;
  return gh;
}

function captureIO(): {
  stdout: string[];
  stderr: string[];
  io: { stdout: (s: string) => void; stderr: (s: string) => void };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (s) => stdout.push(s),
      stderr: (s) => stderr.push(s),
    },
  };
}

function mkBreezeDir(): { dir: string; inbox: string; activity: string } {
  const dir = mkdtempSync(join(tmpdir(), "breeze-poll-"));
  return {
    dir,
    inbox: join(dir, "inbox.json"),
    activity: join(dir, "activity.log"),
  };
}

describe("splitConcatenatedJsonArrays", () => {
  it("splits paginated array output", () => {
    const raw = `[{"id":"1"}][{"id":"2"},{"id":"3"}]`;
    expect(splitConcatenatedJsonArrays(raw)).toEqual([
      `[{"id":"1"}]`,
      `[{"id":"2"},{"id":"3"}]`,
    ]);
  });

  it("handles a single array", () => {
    const raw = `[{"id":"1"}]`;
    expect(splitConcatenatedJsonArrays(raw)).toEqual([`[{"id":"1"}]`]);
  });

  it("ignores brackets inside string values", () => {
    const raw = `[{"title":"hello [world]"}]`;
    expect(splitConcatenatedJsonArrays(raw)).toEqual([raw]);
  });

  it("handles escaped quotes inside strings", () => {
    const raw = `[{"title":"quote \\"]\\" edge"}]`;
    expect(splitConcatenatedJsonArrays(raw)).toEqual([raw]);
  });

  it("returns empty for empty input", () => {
    expect(splitConcatenatedJsonArrays("")).toEqual([]);
  });
});

describe("parseNotifications", () => {
  it("filters CheckSuite + Commit subjects, dedupes by id", () => {
    const raw = `[
      {
        "id": "1",
        "subject": { "type": "PullRequest", "title": "t1", "url": "https://api.github.com/repos/o/r/pulls/12", "latest_comment_url": "https://api.github.com/x" },
        "repository": { "full_name": "o/r" },
        "reason": "review_requested",
        "updated_at": "2026-04-16T10:00:00Z",
        "unread": true
      },
      {
        "id": "2",
        "subject": { "type": "CheckSuite", "title": "ignored", "url": null },
        "repository": { "full_name": "o/r" },
        "reason": "ci_activity",
        "updated_at": "2026-04-16T11:00:00Z",
        "unread": false
      },
      {
        "id": "1",
        "subject": { "type": "PullRequest", "title": "dup", "url": null },
        "repository": { "full_name": "o/r" },
        "reason": "mention",
        "updated_at": "2026-04-16T12:00:00Z",
        "unread": true
      }
    ]`;
    const entries = parseNotifications([raw], "github.com");
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("1");
    expect(entries[0].priority).toBe(1); // review_requested
    expect(entries[0].html_url).toBe("https://github.com/o/r/pull/12");
    expect(entries[0].number).toBe(12);
  });

  it("builds issue html_url for Issue subjects", () => {
    const raw = `[{
      "id": "10",
      "subject": { "type": "Issue", "title": "bug", "url": "https://api.github.com/repos/o/r/issues/42" },
      "repository": { "full_name": "o/r" },
      "reason": "assign",
      "updated_at": "2026-04-16T10:00:00Z",
      "unread": false
    }]`;
    const entries = parseNotifications([raw], "github.com");
    expect(entries[0].html_url).toBe("https://github.com/o/r/issues/42");
    expect(entries[0].number).toBe(42);
    expect(entries[0].priority).toBe(3);
  });

  it("falls back to repo base for Discussion (no number)", () => {
    const raw = `[{
      "id": "20",
      "subject": { "type": "Discussion", "title": "chat", "url": "https://github.com/o/r/discussions/5" },
      "repository": { "full_name": "o/r" },
      "reason": "subscribed",
      "updated_at": "2026-04-16T10:00:00Z",
      "unread": false
    }]`;
    const entries = parseNotifications([raw], "github.com");
    expect(entries[0].html_url).toBe("https://github.com/o/r");
    expect(entries[0].number).toBe(null);
    expect(entries[0].priority).toBe(5);
  });
});

describe("sortEntries", () => {
  it("sorts by priority asc, updated_at desc, id asc", () => {
    const entries = parseNotifications(
      [
        JSON.stringify([
          {
            id: "b",
            subject: { type: "Issue", title: "x", url: null },
            repository: { full_name: "o/r" },
            reason: "mention", // 2
            updated_at: "2026-04-16T10:00:00Z",
            unread: true,
          },
          {
            id: "a",
            subject: { type: "Issue", title: "y", url: null },
            repository: { full_name: "o/r" },
            reason: "review_requested", // 1
            updated_at: "2026-04-16T09:00:00Z",
            unread: true,
          },
          {
            id: "c",
            subject: { type: "Issue", title: "z", url: null },
            repository: { full_name: "o/r" },
            reason: "mention", // 2
            updated_at: "2026-04-16T11:00:00Z",
            unread: true,
          },
        ]),
      ],
      "github.com",
    );
    sortEntries(entries);
    // priority 1 first, then priority 2 sorted by updated_at desc
    expect(entries.map((e) => e.id)).toEqual(["a", "c", "b"]);
  });
});

describe("diffEvents", () => {
  const mkEntry = (
    id: string,
    status: "new" | "wip" | "human" | "done",
  ): ReturnType<typeof parseNotifications>[number] => ({
    id,
    type: "PullRequest",
    reason: "mention",
    repo: "o/r",
    title: "t",
    url: "",
    last_actor: "",
    updated_at: "2026-04-16T10:00:00Z",
    unread: true,
    priority: 2,
    number: 1,
    html_url: "https://github.com/o/r/pull/1",
    gh_state: "OPEN",
    labels: [],
    breeze_status: status,
  });

  it("emits `new` for unseen ids", () => {
    const events = diffEvents(null, [mkEntry("x", "new")]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("new");
  });

  it("emits `transition` for status changes", () => {
    const old = {
      last_poll: "2026-04-16T09:00:00Z",
      notifications: [mkEntry("x", "new")],
    };
    const events = diffEvents(old, [mkEntry("x", "wip")]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("transition");
    expect(events[0].from).toBe("new");
    expect(events[0].to).toBe("wip");
  });

  it("suppresses new → done transitions (auto-merge noise)", () => {
    const old = {
      last_poll: "2026-04-16T09:00:00Z",
      notifications: [mkEntry("x", "new")],
    };
    const events = diffEvents(old, [mkEntry("x", "done")]);
    expect(events).toHaveLength(0);
  });

  it("keeps wip → done transitions", () => {
    const old = {
      last_poll: "2026-04-16T09:00:00Z",
      notifications: [mkEntry("x", "wip")],
    };
    const events = diffEvents(old, [mkEntry("x", "done")]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("transition");
  });
});

describe("runPoll end-to-end", () => {
  let ctx: ReturnType<typeof mkBreezeDir>;
  beforeEach(() => {
    ctx = mkBreezeDir();
  });
  afterEach(() => rmSync(ctx.dir, { recursive: true, force: true }));

  it("fails 1 when gh auth status fails", async () => {
    const gh = makeStubGh([
      {
        match: (argv) => argv[0] === "auth" && argv[1] === "status",
        status: 1,
        stderr: "not logged in",
      },
    ]);
    const { stderr, io } = captureIO();
    const paths = resolveBreezePaths({ env: () => ctx.dir });
    const code = await runPoll([], { gh, io, paths });
    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(/gh not authenticated/u);
  });

  it("writes inbox.json + new events on first poll", async () => {
    const notificationsPage = JSON.stringify([
      {
        id: "n1",
        subject: {
          type: "PullRequest",
          title: "feat: add thing",
          url: "https://api.github.com/repos/o/r/pulls/5",
          latest_comment_url: "https://api.github.com/x",
        },
        repository: { full_name: "o/r" },
        reason: "review_requested",
        updated_at: "2026-04-16T10:00:00Z",
        unread: true,
      },
    ]);
    const graphqlResponse = JSON.stringify({
      data: {
        repository: {
          n5: {
            number: 5,
            state: "OPEN",
            labels: { nodes: [{ name: "breeze:wip" }] },
          },
        },
      },
    });
    const gh = makeStubGh([
      {
        match: (argv) => argv[0] === "auth" && argv[1] === "status",
        status: 0,
      },
      {
        match: (argv) =>
          argv[0] === "api" && argv[1]?.startsWith("/notifications"),
        status: 0,
        stdout: notificationsPage,
      },
      {
        match: (argv) => argv[0] === "api" && argv[1] === "graphql",
        status: 0,
        stdout: graphqlResponse,
      },
    ]);
    const { stdout, io } = captureIO();
    const paths = resolveBreezePaths({ env: () => ctx.dir });
    const code = await runPoll([], {
      gh,
      io,
      paths,
      now: () => new Date("2026-04-16T20:00:00Z"),
    });
    expect(code).toBe(0);
    expect(existsSync(ctx.inbox)).toBe(true);

    const parsed = JSON.parse(readFileSync(ctx.inbox, "utf-8")) as {
      last_poll: string;
      notifications: Array<{
        id: string;
        breeze_status: string;
        labels: string[];
        gh_state: string;
        number: number;
      }>;
    };
    expect(parsed.last_poll).toBe("2026-04-16T20:00:00Z");
    expect(parsed.notifications).toHaveLength(1);
    expect(parsed.notifications[0].id).toBe("n1");
    expect(parsed.notifications[0].breeze_status).toBe("wip");
    expect(parsed.notifications[0].labels).toEqual(["breeze:wip"]);
    expect(parsed.notifications[0].gh_state).toBe("OPEN");

    const events = readActivityLog(ctx.activity);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("new");
    if (events[0].event === "new") {
      expect(events[0].id).toBe("n1");
    }

    expect(stdout.join("\n")).toMatch(/breeze: polled .* 1 notifications \(0 new\)/u);
  });

  it("emits `transition` on status change but suppresses new→done", async () => {
    // Seed an existing inbox with two entries: id=A status=wip, id=B status=new.
    const seedInbox = {
      last_poll: "2026-04-16T09:00:00Z",
      notifications: [
        {
          id: "A",
          type: "PullRequest",
          reason: "review_requested",
          repo: "o/r",
          title: "a",
          url: "https://api.github.com/repos/o/r/pulls/1",
          last_actor: "",
          updated_at: "2026-04-16T09:00:00Z",
          unread: true,
          priority: 1,
          number: 1,
          html_url: "https://github.com/o/r/pull/1",
          gh_state: "OPEN",
          labels: ["breeze:wip"],
          breeze_status: "wip",
        },
        {
          id: "B",
          type: "Issue",
          reason: "mention",
          repo: "o/r",
          title: "b",
          url: "https://api.github.com/repos/o/r/issues/2",
          last_actor: "",
          updated_at: "2026-04-16T09:00:00Z",
          unread: true,
          priority: 2,
          number: 2,
          html_url: "https://github.com/o/r/issues/2",
          gh_state: "OPEN",
          labels: [],
          breeze_status: "new",
        },
      ],
    };
    writeFileSync(ctx.inbox, JSON.stringify(seedInbox), "utf-8");

    // Next poll: A becomes done (wip → done, keep); B becomes done (new → done, suppress).
    const notificationsPage = JSON.stringify([
      {
        id: "A",
        subject: {
          type: "PullRequest",
          title: "a",
          url: "https://api.github.com/repos/o/r/pulls/1",
        },
        repository: { full_name: "o/r" },
        reason: "review_requested",
        updated_at: "2026-04-16T10:00:00Z",
        unread: false,
      },
      {
        id: "B",
        subject: {
          type: "Issue",
          title: "b",
          url: "https://api.github.com/repos/o/r/issues/2",
        },
        repository: { full_name: "o/r" },
        reason: "mention",
        updated_at: "2026-04-16T10:00:00Z",
        unread: false,
      },
    ]);
    const graphqlResponse = JSON.stringify({
      data: {
        repository: {
          n1: { number: 1, state: "MERGED", labels: { nodes: [] } },
          n2: { number: 2, state: "CLOSED", labels: { nodes: [] } },
        },
      },
    });
    const gh = makeStubGh([
      {
        match: (argv) => argv[0] === "auth" && argv[1] === "status",
        status: 0,
      },
      {
        match: (argv) =>
          argv[0] === "api" && argv[1]?.startsWith("/notifications"),
        status: 0,
        stdout: notificationsPage,
      },
      {
        match: (argv) => argv[0] === "api" && argv[1] === "graphql",
        status: 0,
        stdout: graphqlResponse,
      },
    ]);
    const { io } = captureIO();
    const paths = resolveBreezePaths({ env: () => ctx.dir });
    await runPoll([], {
      gh,
      io,
      paths,
      now: () => new Date("2026-04-16T20:00:00Z"),
    });

    const events = readActivityLog(ctx.activity);
    // Only A's wip→done transition should be logged; B's new→done is suppressed.
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("transition");
    if (events[0].event === "transition") {
      expect(events[0].id).toBe("A");
      expect(events[0].from).toBe("wip");
      expect(events[0].to).toBe("done");
    }
  });

  it("survives notifications fetch failure with a warning and exits 0", async () => {
    const gh = makeStubGh([
      {
        match: (argv) => argv[0] === "auth" && argv[1] === "status",
        status: 0,
      },
      {
        match: (argv) =>
          argv[0] === "api" && argv[1]?.startsWith("/notifications"),
        status: 3,
        stderr: "API rate limit exceeded",
      },
    ]);
    const { stderr, io } = captureIO();
    const paths = resolveBreezePaths({ env: () => ctx.dir });
    const code = await runPoll([], { gh, io, paths });
    expect(code).toBe(0);
    expect(stderr.join("\n")).toMatch(/GitHub API failed/u);
    expect(existsSync(ctx.inbox)).toBe(false);
  });

  it("prints help on --help", async () => {
    const { stdout, io } = captureIO();
    const code = await runPoll(["--help"], { io });
    expect(code).toBe(0);
    expect(stdout.join("\n")).toMatch(/Usage: breeze poll/u);
  });
});
