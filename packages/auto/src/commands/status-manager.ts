/**
 * TS port of `breeze-status-manager`.
 *
 * Surface mirrors the bash script exactly — same stdout, stderr, and
 * exit codes for every documented usage. Differences versus bash are
 * confined to internal mechanics (no `jq`, no shell-level `|| true`
 * swallowing at the dispatch layer; gh-level errors are still
 * swallowed inside `GhClient` helpers to preserve the silent
 * "non-labeler fallback" from spec doc 3 §8).
 *
 * Usage (identical to `bash bin/breeze-status-manager`):
 *   get <notification-id>
 *   set <notification-id> <status> [--by <session-id>] [--reason <text>]
 *   claim <notification-id> <session-id> [--action <text>]
 *   release <notification-id>
 *   list [--status <status>]
 *   count [--status <status>]
 *   ensure-labels <repo>
 *
 * Entry point: `runStatusManager(argv, io?)`. `io` is an inject-able
 * struct so tests can capture stdout/stderr and stub the clock, gh
 * client, and paths.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { loadAutoConfig } from "../runtime/config.js";
import { GhClient } from "../runtime/gh.js";
import { resolveAutoPaths } from "../runtime/paths.js";
import { appendActivityEvent } from "../runtime/activity-log.js";
import { readInbox, updateInbox } from "../runtime/store.js";
import {
  type AutoStatus,
  AUTO_LABEL_META,
  ALL_AUTO_LABELS,
  type Inbox,
  type InboxEntry,
} from "../runtime/types.js";

// Re-export of the `AutoStatus` enum for CLI-arg validation.
const AUTO_STATUSES = ["new", "wip", "human", "done"] as const;

export interface StatusManagerIO {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export interface StatusManagerDeps {
  io?: StatusManagerIO;
  gh?: GhClient;
  /** Override paths (mainly for tests). */
  paths?: ReturnType<typeof resolveAutoPaths>;
  /** Override current time for tests. */
  now?: () => Date;
  /** Claim timeout in seconds; default 300. */
  claimTimeoutSecs?: number;
  /** Activity-log writer (overridden in tests). */
  appendActivity?: typeof appendActivityEvent;
}

const DEFAULT_IO: StatusManagerIO = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

function formatUtcIso(date: Date): string {
  // Match `date -u +%Y-%m-%dT%H:%M:%SZ` — seconds-precision, trailing "Z".
  return `${date.toISOString().slice(0, 19)}Z`;
}

function findEntry(inbox: Inbox | null, id: string): InboxEntry | undefined {
  if (!inbox) return undefined;
  return inbox.notifications.find((entry) => entry.id === id);
}

/** Parse `[--flag value] ...` tail into a flag map. Unknown flags are dropped. */
function parseFlagTail(
  args: string[],
  known: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith("--") && known.includes(arg.slice(2))) {
      out[arg.slice(2)] = args[i + 1] ?? "";
      i += 2;
    } else {
      i += 1;
    }
  }
  return out;
}

function printHelp(io: StatusManagerIO): void {
  io.stdout("Usage: auto-status-manager <command> [args]");
  io.stdout("");
  io.stdout("Commands:");
  io.stdout("  get <id>                    Get auto status for a notification");
  io.stdout(
    "  set <id> <status>           Set status (new, wip, human, done) via GitHub labels",
  );
  io.stdout(
    "  claim <id> <session>        Claim a notification for local agent coordination",
  );
  io.stdout("  release <id>                Release a claim");
  io.stdout(
    "  list [--status <status>]    List notification IDs by status",
  );
  io.stdout(
    "  count [--status <status>]   Count notifications by status",
  );
  io.stdout(
    "  ensure-labels <repo>        Create breeze:* labels on a repo",
  );
}

/** Read one line from a file, stripping trailing whitespace. Returns `""` if absent. */
function readLine(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8").replace(/\s+$/u, "");
}

function parseIsoUtc(s: string): number | null {
  // Accept the exact format `bin/breeze-status-manager` writes
  // (`YYYY-MM-DDTHH:MM:SSZ`). Return unix ms, or null on parse failure.
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/u.exec(s);
  if (!m) {
    const fallback = Date.parse(s);
    return Number.isFinite(fallback) ? fallback : null;
  }
  const [, y, mo, d, h, mi, se] = m;
  return Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(se),
  );
}

/** `get` subcommand. Returns exit code. */
async function cmdGet(
  args: string[],
  deps: Required<Pick<StatusManagerDeps, "io">> & StatusManagerDeps,
): Promise<number> {
  const { io } = deps;
  const id = args[0];
  if (!id) {
    io.stderr("ERROR: missing notification id");
    return 1;
  }
  const paths = deps.paths ?? resolveAutoPaths();
  const now = deps.now ?? (() => new Date());
  const claimTimeoutSecs = deps.claimTimeoutSecs ?? 300;

  // Spec doc 2 §3: claims win when non-stale.
  const claimDir = join(paths.claimsDir, id);
  const claimedAtPath = join(claimDir, "claimed_at");
  if (existsSync(claimDir) && existsSync(claimedAtPath)) {
    const ts = parseIsoUtc(readLine(claimedAtPath));
    if (ts !== null) {
      const ageSecs = (now().getTime() - ts) / 1000;
      if (ageSecs < claimTimeoutSecs) {
        io.stdout("wip (claimed)");
        return 0;
      }
    }
  }

  const inbox = readInbox(paths.inbox);
  const entry = findEntry(inbox, id);
  io.stdout(entry?.breeze_status ?? "new");
  return 0;
}

/** `set` subcommand. */
async function cmdSet(
  args: string[],
  deps: Required<Pick<StatusManagerDeps, "io">> & StatusManagerDeps,
): Promise<number> {
  const { io } = deps;
  const id = args[0];
  const status = args[1] as AutoStatus | undefined;
  if (!id || !status) {
    io.stderr("ERROR: missing notification id or status");
    return 1;
  }
  if (!AUTO_STATUSES.includes(status)) {
    io.stderr(
      `ERROR: unknown status '${status}'. Use: new, wip, human, done`,
    );
    return 1;
  }
  const flags = parseFlagTail(args.slice(2), ["by", "reason"]);
  const by = flags.by ?? "";
  const reason = flags.reason ?? "";

  const paths = deps.paths ?? resolveAutoPaths();
  if (!existsSync(paths.root)) mkdirSync(paths.root, { recursive: true });
  if (!existsSync(paths.claimsDir)) {
    mkdirSync(paths.claimsDir, { recursive: true });
  }

  const inbox = readInbox(paths.inbox);
  const entry = findEntry(inbox, id);
  if (!entry || !entry.repo || entry.number === null) {
    io.stderr(`ERROR: cannot find repo/number for notification ${id}`);
    return 1;
  }

  // Old status snapshot BEFORE we rewrite the local inbox copy.
  const oldStatus: AutoStatus = entry.breeze_status;

  const gh = deps.gh ?? new GhClient();
  const repo = entry.repo;
  const num = entry.number;

  // Step 1 (spec doc 3 §3.2): always remove every breeze:* label first.
  for (const lbl of ALL_AUTO_LABELS) {
    gh.removeLabel(repo, num, lbl);
  }

  // Step 2 (spec doc 3 §3.3): add the appropriate label for the new status.
  // For "new" no label is added — absence of breeze:* labels IS "new".
  if (status === "wip" || status === "human" || status === "done") {
    const label = `breeze:${status}` as const;
    const meta = AUTO_LABEL_META[label];
    gh.addLabelWithFallback(repo, num, label, meta.color, meta.description);
  }

  // Step 3: clean up claim if moving away from wip (spec doc 3 §3.5).
  if (status !== "wip") {
    rmSync(join(paths.claimsDir, id), { recursive: true, force: true });
  }

  // Step 4: patch inbox.json optimistically (spec doc 3 §3.6). We take the
  // update lock to avoid racing with the daemon's next poll.
  await updateInbox(
    (current) => {
      if (!current) return current;
      return {
        ...current,
        notifications: current.notifications.map((n) =>
          n.id === id ? { ...n, breeze_status: status } : n,
        ),
      };
    },
    { inboxPath: paths.inbox },
  );

  // Step 5: append transition event to activity.log (spec doc 3 §3.7).
  const now = deps.now ?? (() => new Date());
  const ts = formatUtcIso(now());
  const append = deps.appendActivity ?? appendActivityEvent;
  append(paths.activityLog, {
    ts,
    event: "transition",
    id,
    type: entry.type,
    repo: entry.repo,
    title: entry.title,
    url: entry.html_url,
    by,
    reason,
    from: oldStatus,
    to: status,
  });

  io.stdout(status);
  return 0;
}

/** `claim` subcommand. */
async function cmdClaim(
  args: string[],
  deps: Required<Pick<StatusManagerDeps, "io">> & StatusManagerDeps,
): Promise<number> {
  const { io } = deps;
  const id = args[0];
  const sessionId = args[1];
  if (!id || !sessionId) {
    io.stderr("ERROR: missing notification id or session id");
    return 1;
  }
  // Bash grabs `${1:-working}` as action after shifting id+session, so
  // anything remaining is the action. Explicit positional only.
  const action = args[2] && !args[2].startsWith("--") ? args[2] : "working";

  const paths = deps.paths ?? resolveAutoPaths();
  if (!existsSync(paths.claimsDir)) {
    mkdirSync(paths.claimsDir, { recursive: true });
  }
  const claimDir = join(paths.claimsDir, id);

  const claimTimeoutSecs = deps.claimTimeoutSecs ?? 300;
  const now = deps.now ?? (() => new Date());
  const nowTs = formatUtcIso(now());

  const writeClaim = (): void => {
    writeFileSync(join(claimDir, "claimed_by"), `${sessionId}\n`, "utf-8");
    writeFileSync(join(claimDir, "claimed_at"), `${nowTs}\n`, "utf-8");
    writeFileSync(join(claimDir, "action"), `${action}\n`, "utf-8");
  };

  const firstClaim = tryCreateClaimDir(claimDir, io);
  if (firstClaim === "error") return 1;

  if (firstClaim) {
    writeClaim();
    recordClaimedEvent({ deps, paths, id, sessionId, action, nowTs });
    io.stdout("claimed");
    return 0;
  }

  return resolveExistingClaim({
    claimDir,
    claimTimeoutSecs,
    now,
    writeClaim,
    io,
  });
}

function tryCreateClaimDir(
  claimDir: string,
  io: StatusManagerIO,
): boolean | "error" {
  try {
    // Atomic mkdir — mirrors bash `mkdir "$CLAIMS_DIR/$NOTIF_ID" 2>/dev/null`.
    mkdirSync(claimDir);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EEXIST") return false;
    io.stderr(`ERROR: cannot create claim dir: ${e.message}`);
    return "error";
  }
}

function recordClaimedEvent(args: {
  deps: StatusManagerDeps;
  paths: ReturnType<typeof resolveAutoPaths>;
  id: string;
  sessionId: string;
  action: string;
  nowTs: string;
}): void {
  const { deps, paths, id, sessionId, action, nowTs } = args;
  const inbox = readInbox(paths.inbox);
  const entry = findEntry(inbox, id);
  const append = deps.appendActivity ?? appendActivityEvent;
  append(paths.activityLog, {
    ts: nowTs,
    event: "claimed",
    id,
    type: entry?.type ?? "unknown",
    repo: entry?.repo ?? "unknown",
    title: entry?.title ?? "unknown",
    url: entry?.html_url ?? "",
    by: sessionId,
    action,
  });
}

function resolveExistingClaim(args: {
  claimDir: string;
  claimTimeoutSecs: number;
  now: () => Date;
  writeClaim: () => void;
  io: StatusManagerIO;
}): number {
  const { claimDir, claimTimeoutSecs, now, writeClaim, io } = args;
  const claimedAtPath = join(claimDir, "claimed_at");
  if (!existsSync(claimedAtPath)) {
    // Claim dir exists but no metadata — reclaim.
    writeClaim();
    io.stdout("claimed");
    return 0;
  }
  const ts = parseIsoUtc(readLine(claimedAtPath));
  const ageSecs =
    ts === null ? Number.POSITIVE_INFINITY : (now().getTime() - ts) / 1000;
  if (ageSecs >= claimTimeoutSecs) {
    writeClaim();
    io.stdout("claimed");
    return 0;
  }
  const owner = readLine(join(claimDir, "claimed_by")) || "unknown";
  io.stdout(`already_claimed:${owner}`);
  return 0;
}

/** `release` subcommand. */
async function cmdRelease(
  args: string[],
  deps: Required<Pick<StatusManagerDeps, "io">> & StatusManagerDeps,
): Promise<number> {
  const { io } = deps;
  const id = args[0];
  if (!id) {
    io.stderr("ERROR: missing notification id");
    return 1;
  }
  const paths = deps.paths ?? resolveAutoPaths();
  rmSync(join(paths.claimsDir, id), { recursive: true, force: true });
  io.stdout("released");
  return 0;
}

/** `list` subcommand. */
async function cmdList(
  args: string[],
  deps: Required<Pick<StatusManagerDeps, "io">> & StatusManagerDeps,
): Promise<number> {
  const { io } = deps;
  const flags = parseFlagTail(args, ["status"]);
  const filterStatus = (flags.status as AutoStatus | undefined) ?? "new";
  const paths = deps.paths ?? resolveAutoPaths();
  const inbox = readInbox(paths.inbox);
  if (!inbox) return 0;
  for (const entry of inbox.notifications) {
    if (entry.breeze_status === filterStatus) {
      io.stdout(entry.id);
    }
  }
  return 0;
}

/** `count` subcommand. */
async function cmdCount(
  args: string[],
  deps: Required<Pick<StatusManagerDeps, "io">> & StatusManagerDeps,
): Promise<number> {
  const { io } = deps;
  const flags = parseFlagTail(args, ["status"]);
  const filterStatus = (flags.status as AutoStatus | undefined) ?? "new";
  const paths = deps.paths ?? resolveAutoPaths();
  const inbox = readInbox(paths.inbox);
  const count = !inbox
    ? 0
    : inbox.notifications.filter((n) => n.breeze_status === filterStatus).length;
  io.stdout(String(count));
  return 0;
}

/** `ensure-labels` subcommand. */
async function cmdEnsureLabels(
  args: string[],
  deps: Required<Pick<StatusManagerDeps, "io">> & StatusManagerDeps,
): Promise<number> {
  const { io } = deps;
  const repo = args[0];
  if (!repo) {
    io.stderr("ERROR: missing repo argument");
    return 1;
  }
  const gh = deps.gh ?? new GhClient();
  io.stdout(`Creating breeze labels on ${repo}...`);
  for (const label of ALL_AUTO_LABELS) {
    const meta = AUTO_LABEL_META[label];
    gh.createLabel(repo, label, meta.color, meta.description);
  }
  io.stdout(`Labels created on ${repo}`);
  return 0;
}

/**
 * Entry point. `argv` is the argv *without* the leading `auto` or
 * `status-manager` tokens — i.e. what comes after them.
 */
export async function runStatusManager(
  argv: readonly string[],
  deps: StatusManagerDeps = {},
): Promise<number> {
  const io = deps.io ?? DEFAULT_IO;
  const fullDeps = { ...deps, io };
  // Touch config loader so CLI-vs-env overrides are validated early; kept
  // in scope so Phase 2b can pass config through. No-op side-effect for
  // Phase 2a.
  loadAutoConfig();

  const [cmd = "help", ...rest] = argv;
  switch (cmd) {
    case "get":
      return cmdGet(rest, fullDeps);
    case "set":
      return cmdSet(rest, fullDeps);
    case "claim":
      return cmdClaim(rest, fullDeps);
    case "release":
      return cmdRelease(rest, fullDeps);
    case "list":
      return cmdList(rest, fullDeps);
    case "count":
      return cmdCount(rest, fullDeps);
    case "ensure-labels":
      return cmdEnsureLabels(rest, fullDeps);
    case "help":
    case "--help":
    case "-h":
      printHelp(io);
      return 0;
    default:
      printHelp(io);
      return 0;
  }
}
