/**
 * TS port of `breeze-watch` + `WATCH_DESIGN.md`.
 *
 * A read-only TUI board rendered with `ink` (React-for-terminals):
 *   - header: "breeze status board" + status-count summary
 *   - HUMAN section: always shown, red, critical items
 *   - Board: repos grouped by status (orange NEW, blue WIP, dim green DONE)
 *   - Live feed: tails `activity.log` and renders new events as they arrive
 *
 * Read-only: watches `~/.breeze/inbox.json` (polled) and
 * `~/.breeze/activity.log` (tailed via fs.watch). No writes.
 *
 * Clean shutdown: ink's `useApp().exit()` on Ctrl-C restores cursor/raw-mode.
 */

import { createReadStream, existsSync, statSync, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Box, render, Text, useApp, useInput } from "ink";

import { resolveBreezePaths } from "../runtime/paths.js";
import {
  type ActivityEvent,
  ActivityEventSchema,
  type BreezeStatus,
  type Inbox,
  InboxSchema,
} from "../runtime/types.js";

// Colours chosen to match the bash script's 8-bit SGR palette.
const COLOR = {
  red: "red", // bash: 38;5;196
  orange: "#ff8700", // bash: 38;5;208
  blue: "#00afff", // bash: 38;5;39
  green: "#00af00", // bash: 38;5;34
  dim: "gray",
} as const;

const INBOX_POLL_MS = 1000;
const LIVE_FEED_HISTORY = 20;

interface WatchDeps {
  paths?: ReturnType<typeof resolveBreezePaths>;
  /** Override render target for tests (ink-testing-library). */
  renderImpl?: typeof render;
  /** Override inbox poll interval. */
  inboxPollMs?: number;
}

function truncateTitle(title: string, max = 60): string {
  if (title.length <= max) return title;
  return `${title.slice(0, max - 1)}…`;
}

function shortRepo(repo: string): string {
  const idx = repo.indexOf("/");
  return idx >= 0 ? repo.slice(idx + 1) : repo;
}

/** OSC-8 clickable link (VTE / iTerm / Alacritty honor it). */
function osc8(url: string, text: string): string {
  return `\u001b]8;;${url}\u0007${text}\u001b]8;;\u0007`;
}

function shortLink(url: string, repo: string): string {
  const sr = shortRepo(repo);
  const match = /(\d+)$/u.exec(url);
  const label = match ? `${sr}#${match[1]}` : sr;
  return osc8(url, label);
}

function localTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    // Fall back to the literal T-stripped form.
    const tIdx = iso.indexOf("T");
    return tIdx >= 0 ? iso.slice(tIdx + 1, tIdx + 9) : iso.slice(0, 8);
  }
  return d.toTimeString().slice(0, 8);
}

function statusColor(s: BreezeStatus): string {
  switch (s) {
    case "human":
      return COLOR.red;
    case "new":
      return COLOR.orange;
    case "wip":
      return COLOR.blue;
    case "done":
      return COLOR.green;
  }
}

function statusLabel(s: BreezeStatus): string {
  return s.toUpperCase();
}

// --- header ---

const HeaderBanner = (): React.ReactElement => {
  // Rainbow-tinted "breeze" letters; each letter a fixed colour.
  const letters: Array<[string, string]> = [
    ["b", "red"],
    ["r", "#ff8700"],
    ["e", "#ffd700"],
    ["e", "#00ff00"],
    ["z", "#00ffff"],
    ["e", "#0087ff"],
  ];
  return (
    <Box>
      <Text>  </Text>
      {letters.map(([ch, color], i) => (
        <Text key={i} color={color}>
          {ch}
        </Text>
      ))}
      <Text color={COLOR.dim}>  status board</Text>
    </Box>
  );
};

interface HeaderProps {
  counts: { human: number; new: number; wip: number; done: number };
}

const Header = ({ counts }: HeaderProps): React.ReactElement => (
  <Box flexDirection="column">
    <Text> </Text>
    <HeaderBanner />
    <Text> </Text>
    <Box>
      <Text>  </Text>
      {counts.human > 0 ? (
        <Text color={COLOR.red} bold>
          ● {counts.human} human
        </Text>
      ) : (
        <Text color={COLOR.dim}>● 0 human  </Text>
      )}
      <Text color={COLOR.orange}>● {counts.new} new  </Text>
      <Text color={COLOR.blue}>● {counts.wip} wip  </Text>
      <Text color={COLOR.green} dimColor>
        ● {counts.done} done
      </Text>
    </Box>
    <Text> </Text>
    <Text color={COLOR.dim}>
      {"  ────────────────────────────────────────────────────────"}
    </Text>
    <Text> </Text>
  </Box>
);

// --- human section ---

interface HumanSectionProps {
  inbox: Inbox | null;
}

const HumanSection = ({ inbox }: HumanSectionProps): React.ReactElement => {
  const humans = inbox?.notifications.filter(
    (n) => n.breeze_status === "human",
  ) ?? [];
  if (humans.length === 0) {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={COLOR.red} bold>
            ▶ HUMAN
          </Text>
          <Text color={COLOR.dim}>
            {"  (0) — ✨ nothing needs you right now"}
          </Text>
        </Box>
        <Text> </Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={COLOR.red} bold>
          ▶ HUMAN
        </Text>
        <Text bold>{`  (${humans.length})`}</Text>
        <Text color={COLOR.dim}> — you block these</Text>
      </Box>
      {humans.map((n) => (
        <Box key={n.id}>
          <Text color={COLOR.red}>{"  ● "}</Text>
          <Text>{shortLink(n.html_url, n.repo)}</Text>
          <Text>{"  "}</Text>
          <Text>{truncateTitle(n.title, 60)}</Text>
        </Box>
      ))}
      <Text> </Text>
    </Box>
  );
};

// --- board grouped by repo ---

interface BoardProps {
  inbox: Inbox | null;
}

const Board = ({ inbox }: BoardProps): React.ReactElement | null => {
  const groups = useMemo(() => {
    const byRepo = new Map<
      string,
      { new: typeof inbox extends null ? never : Inbox["notifications"]; wip: Inbox["notifications"]; done: Inbox["notifications"] }
    >();
    if (!inbox) return [];
    for (const n of inbox.notifications) {
      if (n.breeze_status === "human") continue;
      const row = byRepo.get(n.repo) ?? { new: [], wip: [], done: [] };
      if (n.breeze_status === "new") row.new.push(n);
      else if (n.breeze_status === "wip") row.wip.push(n);
      else if (n.breeze_status === "done") row.done.push(n);
      byRepo.set(n.repo, row);
    }
    // Sort repos by open count desc. Drop repos with zero open items.
    return [...byRepo.entries()]
      .map(([repo, row]) => ({
        repo,
        open: row.new.length + row.wip.length,
        ...row,
      }))
      .filter((r) => r.open > 0)
      .sort((a, b) => b.open - a.open);
  }, [inbox]);

  if (groups.length === 0) return null;

  return (
    <Box flexDirection="column">
      {groups.map((g) => (
        <Box key={g.repo} flexDirection="column">
          <Box>
            <Text bold>{shortRepo(g.repo)}</Text>
            <Text color={COLOR.dim}>
              {` (${g.open} open · ${g.done.length} done)`}
            </Text>
          </Box>
          {g.wip.length > 0 ? (
            <Box flexDirection="column">
              <Text color={COLOR.blue}>{`  ○ WIP (${g.wip.length})`}</Text>
              {g.wip.slice(0, 5).map((n) => (
                <Box key={n.id}>
                  <Text>{"    "}</Text>
                  <Text>{shortLink(n.html_url, n.repo)}</Text>
                  <Text>{"  "}</Text>
                  <Text>{truncateTitle(n.title, 60)}</Text>
                </Box>
              ))}
              {g.wip.length > 5 ? (
                <Text color={COLOR.dim}>
                  {`    … and ${g.wip.length - 5} more`}
                </Text>
              ) : null}
            </Box>
          ) : null}
          {g.new.length > 0 ? (
            <Box flexDirection="column">
              <Text color={COLOR.orange}>{`  ○ NEW (${g.new.length})`}</Text>
              {g.new.slice(0, 5).map((n) => (
                <Box key={n.id}>
                  <Text>{"    "}</Text>
                  <Text>{shortLink(n.html_url, n.repo)}</Text>
                  <Text>{"  "}</Text>
                  <Text>{truncateTitle(n.title, 60)}</Text>
                </Box>
              ))}
              {g.new.length > 5 ? (
                <Text color={COLOR.dim}>
                  {`    … and ${g.new.length - 5} more`}
                </Text>
              ) : null}
            </Box>
          ) : null}
          {g.done.length > 0 ? (
            <Text color={COLOR.green} dimColor>
              {`  ○ DONE (${g.done.length}) — collapsed`}
            </Text>
          ) : null}
          <Text> </Text>
        </Box>
      ))}
    </Box>
  );
};

// --- live feed ---

interface LiveFeedProps {
  events: readonly ActivityEvent[];
}

const LiveFeed = ({ events }: LiveFeedProps): React.ReactElement => (
  <Box flexDirection="column">
    <Text color={COLOR.dim}>
      {"────── live ─────────────────────────────────────────────"}
    </Text>
    <Text> </Text>
    {events.map((e, i) => (
      <LiveEvent key={i} event={e} />
    ))}
  </Box>
);

interface LiveEventProps {
  event: ActivityEvent;
}

const LiveEvent = ({ event }: LiveEventProps): React.ReactElement | null => {
  if (event.event === "poll") return null;
  const time = localTime(event.ts);
  if (event.event === "new") {
    return (
      <Box>
        <Text color={COLOR.dim}>{time}</Text>
        <Text>{"  "}</Text>
        <Text color={COLOR.orange}>▸ NEW         </Text>
        <Text>{shortLink(event.url, event.repo)}</Text>
        <Text>{"  "}</Text>
        <Text>{truncateTitle(event.title, 50)}</Text>
      </Box>
    );
  }
  if (event.event === "claimed") {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={COLOR.dim}>{time}</Text>
          <Text>{"  "}</Text>
          <Text color={COLOR.blue}>⚡ CLAIM       </Text>
          <Text>{shortLink(event.url, event.repo)}</Text>
          <Text>{"  "}</Text>
          <Text>{truncateTitle(event.title, 50)}</Text>
        </Box>
        {event.by ? (
          <Text color={COLOR.dim}>{`              ↳ by ${event.by}`}</Text>
        ) : null}
      </Box>
    );
  }
  // transition
  const toHuman = event.to === "human";
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={COLOR.dim}>{time}</Text>
        <Text>{"  "}</Text>
        <Text color={statusColor(event.from)}>{statusLabel(event.from)}</Text>
        <Text>{" → "}</Text>
        <Text color={statusColor(event.to)} bold={toHuman}>
          {statusLabel(event.to)}
        </Text>
        <Text>{"  "}</Text>
        <Text>{shortLink(event.url, event.repo)}</Text>
        <Text>{"  "}</Text>
        <Text>{truncateTitle(event.title, 50)}</Text>
      </Box>
      {event.reason ? (
        <Text color={toHuman ? COLOR.red : COLOR.dim} dimColor={!toHuman}>
          {`              ↳ ${event.reason}`}
        </Text>
      ) : null}
    </Box>
  );
};

// --- root component ---

export interface BreezeWatchProps {
  inbox: Inbox | null;
  events: readonly ActivityEvent[];
}

export const BreezeWatch = ({
  inbox,
  events,
}: BreezeWatchProps): React.ReactElement => {
  const counts = useMemo(() => {
    const out = { human: 0, new: 0, wip: 0, done: 0 };
    if (!inbox) return out;
    for (const n of inbox.notifications) {
      out[n.breeze_status] += 1;
    }
    return out;
  }, [inbox]);
  return (
    <Box flexDirection="column">
      <Header counts={counts} />
      <HumanSection inbox={inbox} />
      <Board inbox={inbox} />
      <LiveFeed events={events} />
    </Box>
  );
};

// --- data wiring ---

function safeParseInbox(raw: string): Inbox | null {
  try {
    const parsed = InboxSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function safeParseActivity(line: string): ActivityEvent | null {
  try {
    const parsed = ActivityEventSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Inner component that owns the live data streams. Separated from
 * `BreezeWatch` (the pure view) so ink-testing-library can render the view
 * with canned props without touching the filesystem.
 */
const WatchApp = ({
  paths,
  inboxPollMs,
}: {
  paths: ReturnType<typeof resolveBreezePaths>;
  inboxPollMs: number;
}): React.ReactElement => {
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const lastInboxMtime = useRef<number>(-1);
  const logPos = useRef<number>(0);
  const { exit } = useApp();

  useInput((input, key) => {
    if (key.ctrl && input === "c") exit();
    if (input === "q") exit();
  });

  // Inbox poller — re-read only when mtime changes.
  useEffect(() => {
    const tick = async (): Promise<void> => {
      if (!existsSync(paths.inbox)) return;
      try {
        const mtime = statSync(paths.inbox).mtimeMs;
        if (mtime === lastInboxMtime.current) return;
        lastInboxMtime.current = mtime;
        const raw = await readFile(paths.inbox, "utf-8");
        const parsed = safeParseInbox(raw);
        if (parsed) setInbox(parsed);
      } catch {
        // Transient read during rename — next tick catches it.
      }
    };
    void tick();
    const handle = setInterval(tick, inboxPollMs);
    return () => clearInterval(handle);
  }, [paths.inbox, inboxPollMs]);

  // Activity-log tail. Seed from the last N lines, then tail.
  useEffect(() => {
    let cancelled = false;
    const seed = async (): Promise<void> => {
      if (!existsSync(paths.activityLog)) {
        logPos.current = 0;
        return;
      }
      try {
        const raw = await readFile(paths.activityLog, "utf-8");
        const lines = raw.split("\n").filter((l) => l.trim());
        const tail = lines.slice(-LIVE_FEED_HISTORY);
        const parsed = tail
          .map(safeParseActivity)
          .filter((e): e is ActivityEvent => e !== null);
        if (!cancelled) setEvents(parsed);
        logPos.current = Buffer.byteLength(raw, "utf-8");
      } catch {
        logPos.current = 0;
      }
    };
    void seed();

    let buffer = "";
    const onChange = async (): Promise<void> => {
      try {
        const size = statSync(paths.activityLog).size;
        if (size < logPos.current) {
          // Log was truncated; re-seed.
          logPos.current = 0;
          buffer = "";
        }
        if (size === logPos.current) return;
        const stream = createReadStream(paths.activityLog, {
          start: logPos.current,
          end: size - 1,
          encoding: "utf-8",
        });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        const newEvents: ActivityEvent[] = [];
        rl.on("line", (line) => {
          const combined = buffer + line;
          buffer = "";
          const parsed = safeParseActivity(combined);
          if (parsed) newEvents.push(parsed);
        });
        await new Promise<void>((resolve, reject) => {
          rl.on("close", () => resolve());
          stream.on("error", reject);
        });
        logPos.current = size;
        if (!cancelled && newEvents.length > 0) {
          setEvents((prev) => {
            const merged = [...prev, ...newEvents];
            return merged.slice(-LIVE_FEED_HISTORY);
          });
        }
      } catch {
        // Ignore — next change event retries.
      }
    };

    let watcher: ReturnType<typeof watch> | null = null;
    try {
      if (existsSync(paths.activityLog)) {
        watcher = watch(paths.activityLog, () => {
          void onChange();
        });
      }
    } catch {
      // fs.watch not supported (some Linux filesystems) — poll instead.
    }
    const pollHandle = setInterval(() => void onChange(), inboxPollMs);

    return () => {
      cancelled = true;
      if (watcher) watcher.close();
      clearInterval(pollHandle);
    };
  }, [paths.activityLog, inboxPollMs]);

  return <BreezeWatch inbox={inbox} events={events} />;
};

/**
 * Entry point for `first-tree breeze watch`.
 *
 * Returns the exit code (always 0 for now — Ctrl-C exits cleanly).
 */
export async function runWatch(
  _argv: readonly string[],
  deps: WatchDeps = {},
): Promise<number> {
  const paths = deps.paths ?? resolveBreezePaths();
  const renderImpl = deps.renderImpl ?? render;
  const inboxPollMs = deps.inboxPollMs ?? INBOX_POLL_MS;

  const instance = renderImpl(
    <WatchApp paths={paths} inboxPollMs={inboxPollMs} />,
  );
  await instance.waitUntilExit();
  return 0;
}

export default runWatch;
