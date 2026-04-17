/**
 * Tests for `src/products/breeze/engine/runtime/store.ts`.
 *
 * Covers:
 *   - round-trip: read the real-shape sample, write it back, ensure
 *     JSON parse still works and all keys are preserved.
 *   - atomic rename (no `.tmp` left behind).
 *   - zod validation rejects malformed inbox loudly.
 *   - concurrent writers: two simultaneous `updateInbox` calls are
 *     serialized by the advisory lock.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readInbox,
  updateInbox,
  writeInbox,
} from "../../src/products/breeze/engine/runtime/store.js";
import type { Inbox } from "../../src/products/breeze/engine/runtime/types.js";

const FIXTURE = join(__dirname, "..", "fixtures", "breeze", "inbox-sample.json");

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "breeze-store-"));
}

describe("readInbox / writeInbox", () => {
  let dir: string;
  let inboxPath: string;
  beforeEach(() => {
    dir = mkTmp();
    inboxPath = join(dir, "inbox.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when inbox does not exist", () => {
    expect(readInbox(inboxPath)).toBeNull();
  });

  it("round-trips the sample fixture without mutation", () => {
    const sample = JSON.parse(readFileSync(FIXTURE, "utf-8")) as Inbox;
    writeInbox(inboxPath, sample);
    const reparsed = readInbox(inboxPath);
    expect(reparsed).not.toBeNull();
    expect(reparsed).toEqual(sample);
  });

  it("preserves null values for nullable fields (number, gh_state)", () => {
    const sample = JSON.parse(readFileSync(FIXTURE, "utf-8")) as Inbox;
    writeInbox(inboxPath, sample);
    const onDisk = JSON.parse(readFileSync(inboxPath, "utf-8")) as {
      notifications: Array<Record<string, unknown>>;
    };
    const discussion = onDisk.notifications.find(
      (n) => n.type === "Discussion",
    );
    expect(discussion).toBeDefined();
    // Explicitly confirm these keys exist with null values (not omitted).
    expect(Object.prototype.hasOwnProperty.call(discussion!, "number")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(discussion!, "gh_state")).toBe(true);
    expect(discussion!.number).toBeNull();
    expect(discussion!.gh_state).toBeNull();
  });

  it("writes atomically (no .tmp file left after success)", () => {
    const sample = JSON.parse(readFileSync(FIXTURE, "utf-8")) as Inbox;
    writeInbox(inboxPath, sample);
    expect(existsSync(`${inboxPath}.tmp`)).toBe(false);
    expect(existsSync(inboxPath)).toBe(true);
  });

  it("emits every field in Rust-compatible key order", () => {
    const sample = JSON.parse(readFileSync(FIXTURE, "utf-8")) as Inbox;
    writeInbox(inboxPath, sample);
    const raw = readFileSync(inboxPath, "utf-8");
    // First entry should have keys in the fetcher.rs:601-631 order.
    // Grep the first entry's key sequence and check the order.
    const firstEntryMatch = raw.match(/"notifications":\[\{([^}]+)\}/u);
    expect(firstEntryMatch).toBeTruthy();
    const keyOrder =
      Array.from(
        firstEntryMatch![1].matchAll(/"(id|type|reason|repo|title|url|last_actor|updated_at|unread|priority|number|html_url|gh_state|labels|breeze_status)"/gu),
      ).map((m) => m[1]);
    expect(keyOrder).toEqual([
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

  it("throws on malformed JSON", () => {
    writeFileSync(inboxPath, "{not valid json", "utf-8");
    expect(() => readInbox(inboxPath)).toThrow(/not valid JSON/u);
  });

  it("throws on schema mismatch", () => {
    writeFileSync(
      inboxPath,
      JSON.stringify({ last_poll: 123, notifications: "nope" }),
      "utf-8",
    );
    expect(() => readInbox(inboxPath)).toThrow(/schema validation/u);
  });

  it("throws on empty file (not auto-heal)", () => {
    writeFileSync(inboxPath, "", "utf-8");
    expect(() => readInbox(inboxPath)).toThrow(/empty/u);
  });
});

describe("updateInbox — concurrency / locking", () => {
  let dir: string;
  let inboxPath: string;

  beforeEach(() => {
    dir = mkTmp();
    inboxPath = join(dir, "inbox.json");
    const sample = JSON.parse(readFileSync(FIXTURE, "utf-8")) as Inbox;
    writeInbox(inboxPath, sample);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies a mutator under the lock and returns the new inbox", async () => {
    const result = await updateInbox(
      (current) => {
        if (!current) return current;
        return {
          ...current,
          notifications: current.notifications.map((n) =>
            n.id === "23576674030" ? { ...n, breeze_status: "wip" as const } : n,
          ),
        };
      },
      { inboxPath },
    );
    expect(result).not.toBeNull();
    const reparsed = readInbox(inboxPath);
    const entry = reparsed?.notifications.find((n) => n.id === "23576674030");
    expect(entry?.breeze_status).toBe("wip");
  });

  it("serializes two concurrent writers (no lost update)", async () => {
    // Two concurrent update calls: each appends a sentinel label to the
    // first entry. If the lock works, both labels end up present. If the
    // lock fails (last-writer-wins without serialization), only one does.
    const sentinels = ["sentinel-a", "sentinel-b"];
    const tasks = sentinels.map((label) =>
      updateInbox(
        (current) => {
          if (!current) return current;
          return {
            ...current,
            notifications: current.notifications.map((n) =>
              n.id === "23576674030"
                ? { ...n, labels: [...n.labels, label] }
                : n,
            ),
          };
        },
        { inboxPath },
      ),
    );
    await Promise.all(tasks);
    const final = readInbox(inboxPath);
    const entry = final?.notifications.find((n) => n.id === "23576674030");
    expect(entry?.labels).toContain("sentinel-a");
    expect(entry?.labels).toContain("sentinel-b");
  });

  it("supports first-write (no inbox yet) via dir-level lock", async () => {
    const freshDir = mkTmp();
    const freshInbox = join(freshDir, "inbox.json");
    try {
      await updateInbox(
        (current) => {
          expect(current).toBeNull();
          return {
            last_poll: "2026-04-16T20:15:30Z",
            notifications: [],
          };
        },
        { inboxPath: freshInbox },
      );
      expect(existsSync(freshInbox)).toBe(true);
      const reparsed = readInbox(freshInbox);
      expect(reparsed?.notifications).toHaveLength(0);
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it("mutator returning null aborts without writing", async () => {
    const before = readFileSync(inboxPath, "utf-8");
    const result = await updateInbox(() => null, { inboxPath });
    expect(result).toBeNull();
    const after = readFileSync(inboxPath, "utf-8");
    expect(after).toBe(before);
  });
});
