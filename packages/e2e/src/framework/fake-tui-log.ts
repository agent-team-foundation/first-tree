import { existsSync, readFileSync } from "node:fs";

/**
 * Reader for the side-channel log written by `mocks/fake-claude-tui.mjs`.
 *
 * The fake binary appends a JSON object per event (start, ready, turn:start,
 * turn:end, escape:idle, eof, crash, fatal). Tests assert on the timeline
 * (e.g. "two turns ran in this session", "the spawn argv carried the
 * expected flags") without having to parse the transcript file format the
 * handler also consumes.
 *
 * Path is chosen by the test fixture and exported into the daemon via
 * `FAKE_TUI_LOG_PATH`; one path per fixture instance keeps logs from
 * different agents disjoint.
 */
export type FakeTuiEvent = {
  kind: "start" | "ready" | "turn:start" | "turn:end" | "turn:hang" | "escape:idle" | "eof" | "crash" | "fatal";
  sessionId: string;
  resumeId: string | null;
  ts: string;
  pid: number;
} & Record<string, unknown>;

export class FakeTuiLogReader {
  constructor(public readonly path: string) {}

  /** Returns every event currently on disk; tolerates a missing file. */
  readAll(): FakeTuiEvent[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, "utf-8");
    const out: FakeTuiEvent[] = [];
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      try {
        out.push(JSON.parse(raw) as FakeTuiEvent);
      } catch {
        // skip malformed (fake should not write malformed; tolerate during
        // partial-line races with the running fake)
      }
    }
    return out;
  }

  /** Convenience: events whose `kind` matches. */
  byKind(kind: FakeTuiEvent["kind"]): FakeTuiEvent[] {
    return this.readAll().filter((e) => e.kind === kind);
  }

  /** First event of the given kind, or null. */
  first(kind: FakeTuiEvent["kind"]): FakeTuiEvent | null {
    return this.byKind(kind)[0] ?? null;
  }

  /** Last event of the given kind, or null. */
  last(kind: FakeTuiEvent["kind"]): FakeTuiEvent | null {
    const events = this.byKind(kind);
    return events[events.length - 1] ?? null;
  }

  /** True iff at least one matching event has been written. */
  has(kind: FakeTuiEvent["kind"]): boolean {
    return this.byKind(kind).length > 0;
  }

  /**
   * Poll until `predicate(events)` is true or the timeout expires. Returns
   * the matching event list. Throws on timeout with the last-seen list
   * stringified for diagnostics.
   */
  async waitUntil(
    predicate: (events: FakeTuiEvent[]) => boolean,
    opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
  ): Promise<FakeTuiEvent[]> {
    const timeout = opts.timeoutMs ?? 15_000;
    const interval = opts.intervalMs ?? 100;
    const started = Date.now();
    let last: FakeTuiEvent[] = [];
    while (Date.now() - started < timeout) {
      last = this.readAll();
      if (predicate(last)) return last;
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(
      `fake-tui log wait timed out after ${timeout}ms${opts.label ? ` (${opts.label})` : ""}. ` +
        `Last events: ${JSON.stringify(last.map((e) => e.kind))}`,
    );
  }
}
