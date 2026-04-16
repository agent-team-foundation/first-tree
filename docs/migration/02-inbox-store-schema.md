# 02 — `~/.breeze/` Store Schema

Source of truth:
- `first-tree-breeze/breeze-runner/src/fetcher.rs` (981 lines, esp. `write_inbox`,
  `append_activity_events`, `InboxEntry`, `ActivityEvent`, `resolve_inbox_dir`)
- `first-tree-breeze/breeze-runner/src/store.rs` (180 lines — runner store)
- `first-tree-breeze/breeze-runner/src/json.rs` (140 lines — encoder)
- `first-tree-breeze/breeze-runner/src/lock.rs`
- `first-tree-breeze/breeze-runner/src/task.rs` (`ThreadRecord`)
- `first-tree-breeze/bin/breeze-status-manager` (claims directory)
- Live `~/.breeze/inbox.json` and `~/.breeze/activity.log` observed on this
  machine on 2026-04-16 (redacted examples below).

The store is split into two trees with different ownership:

```
~/.breeze/                       (shared — statusline + skill + poller read)
├── inbox.json                   (sole writer: Rust fetcher OR bin/breeze-poll)
├── activity.log                 (writers: Rust fetcher AND bin/breeze-status-manager)
└── claims/                      (writers: bin/breeze-status-manager; reader: Rust fetcher cleanup)
    └── <notification-id>/
        ├── claimed_at           (ISO-8601 UTC)
        ├── claimed_by           (session id)
        └── action               (free-text label)
```

```
~/.breeze/runner/                (Rust daemon's private state)
├── threads/<fileid>.env         (per-thread bookkeeping)
├── tasks/<task-id>/
│   ├── task.env                 (per-task metadata)
│   ├── prompt.txt               (prompt fed to the agent)
│   ├── runner-output.txt        (agent's output_last_message content)
│   ├── runner-stdout.log
│   ├── runner-stderr.log
│   └── snapshot/                (frozen gh API pulls for the agent)
│       ├── task-summary.env
│       ├── README.txt
│       ├── subject.json + subject.json.meta
│       ├── latest-comment.json + .meta
│       ├── pr-view.json + .meta
│       ├── pr.diff + .meta
│       ├── pr-reviews.json + .meta
│       ├── issue-view.json + .meta        (issue path only)
│       └── issue-comments.json + .meta
├── repos/<owner>__<name>.git/   (bare mirrors)
├── workspaces/<repo-slug>/<kind>-<stable-id>/  (git worktrees)
├── locks/<host>__<login>__<profile>/
│   └── lock.env
├── broker/
│   ├── bin/gh                   (POSIX shim script)
│   ├── requests/req-<epoch>-<pid>-<rand>/
│   │   ├── argv.txt
│   │   ├── cwd.txt
│   │   ├── gh_host.txt          (optional)
│   │   ├── gh_repo.txt          (optional)
│   │   ├── stdout.txt           (written by broker)
│   │   ├── stderr.txt           (written by broker)
│   │   └── response.env         (sentinel for shim; rm -rf'd by shim after read)
│   └── history/<fingerprint-id>/
│       ├── stdout.txt
│       ├── stderr.txt
│       └── response.env
├── logs/breeze-runner-<epoch>.log   (stdout+stderr from nohup/launchd)
├── runtime/status.env
└── launchd/com.breeze.runner.<login>.<profile>.plist   (macOS only)
```

`resolve_inbox_dir` (`fetcher.rs:652-657`) honors `$BREEZE_DIR` and otherwise
uses `$HOME/.breeze`. The runner home defaults to `$HOME/.breeze/runner`
(`config.rs:166-167`, honors `$BREEZE_HOME`). So the shared shell-visible tree
and the Rust daemon's private tree are separate by convention.

## 1. `~/.breeze/inbox.json`

Produced by `write_inbox` (`fetcher.rs:583-599`) — **atomic** rename from
`inbox.json.tmp` to `inbox.json`. Entry encoding is in
`entry_to_json` (`fetcher.rs:601-631`).

Top-level shape:

```jsonc
{
  "last_poll": "2026-04-16T20:15:30Z",   // string; ISO-8601 UTC, seconds-precision
  "notifications": [ /* InboxEntry objects, sorted (see below) */ ]
}
```

### 1.1 `InboxEntry` fields (`fetcher.rs:22-38` and `entry_to_json`)

All fields are always present (the encoder never omits keys); nullable fields
use JSON `null`.

| Key             | JSON type            | Source/meaning | Notes |
|-----------------|----------------------|----------------|-------|
| `id`            | string               | GitHub notification thread id | Opaque; stable across polls |
| `type`          | string               | `subject.type` from `/notifications` | E.g. `PullRequest`, `Issue`, `Discussion`, `Release`, `CheckSuite`, `Commit` (last two filtered upstream, see `fetcher.rs:15`) |
| `reason`        | string               | Raw GitHub `reason` | E.g. `review_requested`, `mention`, `team_mention`, `comment`, `assign`, `author`, `manual`, `subscribed`, `participating` |
| `repo`          | string               | `repository.full_name` (`owner/name`) | |
| `title`         | string               | `subject.title` | Free-text |
| `url`           | string               | `subject.url` (API URL) | May point at a PR or issue API path |
| `last_actor`    | string               | `subject.latest_comment_url // subject.url` | Despite the name, this is a URL, not a login. (Verified in live sample: it holds `https://api.github.com/.../issues/comments/<id>` values.) |
| `updated_at`    | string               | `updated_at` from GitHub | ISO-8601 UTC |
| `unread`        | bool                 | `unread` | |
| `priority`      | number (int64)       | `priority_for_reason(reason)` (`fetcher.rs:370-378`) | Lower = more urgent. See table below |
| `number`        | number or null       | Trailing digits parsed from `url` (`fetcher.rs:380-390`) | null for Discussions / non-numeric subjects |
| `html_url`      | string               | Rebuilt `https://<host>/<repo>/pull/<n>` or `/issues/<n>` (`fetcher.rs:392-399`) | Falls back to `https://<host>/<repo>` when no number |
| `gh_state`      | string or null       | From GraphQL label enrichment | `"OPEN"`, `"CLOSED"`, `"MERGED"`, or null |
| `labels`        | array of strings     | From GraphQL label enrichment (`first: 10`) | Empty array if none or if enrichment skipped |
| `breeze_status` | string               | Derived (`compute_breeze_status`, `fetcher.rs:353-368`) | One of `"new" | "wip" | "human" | "done"` |

`priority` table (`fetcher.rs:370-378` — note these are **inbox display
priorities**, lower = more urgent, distinct from the dispatcher `priority_for`
in `classify.rs` which is higher = more urgent):

| `reason`            | `priority` |
|---------------------|------------|
| `review_requested`  | 1          |
| `mention`           | 2          |
| `assign`            | 3          |
| `participating`     | 4          |
| anything else       | 5          |

Sort order (`sort_entries`, `fetcher.rs:401-408`): `priority` asc, then
`updated_at` desc, then `id` asc.

### 1.2 Real example (redacted, from live `~/.breeze/inbox.json`)

```json
{
  "last_poll": "2026-04-16T20:15:30Z",
  "notifications": [
    {
      "id": "23576674030",
      "type": "PullRequest",
      "reason": "author",
      "repo": "serenakeyitan/paperclip-tree",
      "title": "fix(tree): salvage nya1 member node from closed sync PR 282",
      "url": "https://api.github.com/repos/serenakeyitan/paperclip-tree/pulls/290",
      "last_actor": "https://api.github.com/repos/serenakeyitan/paperclip-tree/issues/comments/4258143984",
      "updated_at": "2026-04-16T07:24:28Z",
      "unread": false,
      "priority": 5,
      "number": 290,
      "html_url": "https://github.com/serenakeyitan/paperclip-tree/pull/290",
      "gh_state": "OPEN",
      "labels": [],
      "breeze_status": "new"
    }
  ]
}
```

### 1.3 Writer invariants

- Written via `write_text(tmp) + fs::rename(tmp, inbox.json)` in
  `fetcher.rs:594-597`. On POSIX this is atomic w.r.t. concurrent readers.
- Encoder guarantees no internal whitespace (`json.rs` builds a compact string).
  The live file observed has whitespace — that is from the legacy
  `bin/breeze-poll` bash script (`jq ... > file`), NOT the Rust writer. Readers
  must cope with both pretty-printed and compact inbox JSON.
- The Rust fetcher is the **sole writer** under the `run`/`run-once` daemon.
  `bin/breeze-status-manager set` however *also* does a best-effort inline
  `jq` rewrite of `inbox.json` (`breeze-status-manager:143-149`) to update the
  local `breeze_status` optimistically before the next poll confirms it. This
  violates single-writer cleanly, and Phase 3 should decide whether to keep
  that behaviour. The races are short (the user-set label gets overwritten on
  the next poll anyway).

### 1.4 Reader contract

Documented callers:
- `/inbox` HTTP route (see doc #1) — passthrough.
- `bin/breeze-status-manager` — uses `jq` to read/write selected fields.
- `bin/breeze-statusline-wrapper` and the `/breeze` skill (not in this repo).

Unverified: the `bin/breeze-statusline-wrapper` script is 7 lines and likely
execs `bin/breeze-status`. Check before removal.

## 2. `~/.breeze/activity.log`

Append-only JSONL (one JSON object per line, terminated by `\n`).
Produced by two writers:

### 2.1 Rust fetcher writer (`fetcher.rs:633-650`)

`append_activity_events` reads the existing file, ensures a trailing newline,
then appends one JSON line per `ActivityEvent`. Not atomic across processes:
the Rust code uses `write_text` (full file rewrite), so a concurrent reader
that opens mid-write might see a truncated tail. In practice all writes happen
from one process.

Event kinds produced by the fetcher (`fetcher.rs:472-537`):

**`event: "new"`** — a notification id was not in the previous poll state.

```json
{"ts":"2026-04-16T20:15:30Z","event":"new","id":"23576674030","type":"PullRequest","repo":"owner/repo","title":"...","url":"https://github.com/owner/repo/pull/290"}
```

Fields: `ts, event, id, type, repo, title, url`. Note: `url` here is the
`html_url`, not the API url.

**`event: "transition"`** — a notification's `breeze_status` changed since
the previous poll. The fetcher intentionally suppresses `new → done`
transitions that are purely from GitHub auto-close/merge (`fetcher.rs:564-568`).

```json
{"ts":"...","event":"transition","id":"...","type":"...","repo":"...","title":"...","url":"...","from":"new","to":"wip"}
```

### 2.2 `bin/breeze-status-manager` writer

This shell script appends its own events directly via `>> "$LOG_FILE"`
(`breeze-status-manager:39-41`). Events it writes:

**`event: "transition"`** (with extra `by` + `reason` fields):

```json
{"ts":"2026-04-16T20:15:30Z","event":"transition","id":"...","type":"...","repo":"...","title":"...","url":"...","by":"session-id","reason":"why","from":"new","to":"wip"}
```

**`event: "claimed"`** (claim acquired):

```json
{"ts":"...","event":"claimed","id":"...","type":"...","repo":"...","title":"...","url":"...","by":"session-id","action":"working"}
```

### 2.3 Legacy bash `bin/breeze-poll` writer

Also appends events when used as the legacy poller. Observed on this machine
(the Rust daemon is not currently running):

**`event: "poll"`** — only emitted when the bash poller detected new
notifications on this cycle (`bin/breeze-poll:262-265`):

```json
{"ts":"2026-04-16T20:15:30Z","event":"poll","count":422}
```

The Rust poller does NOT emit `poll` events — Phase 3 should decide whether to
preserve this for dashboards/log-viewers that look for it (`breeze-watch`).

### 2.4 Reader contract

- `/activity` HTTP endpoint tails the last 200 lines (see doc #1).
- `bin/breeze-watch` tails the log for a live dashboard.
- SSE `activity` events carry one-line payloads matching 2.1 exactly.

No rotation today. The file grows unboundedly. Phase 3 should add rotation —
the TS port is a natural place to introduce it.

## 3. `~/.breeze/claims/`

Owned by `bin/breeze-status-manager` (`breeze-status-manager:172-220`).
Cleaned up by the Rust fetcher's `cleanup_expired_claims`
(`fetcher.rs:659-688`, called from `service.rs:221, 399`).

Layout: `~/.breeze/claims/<notification-id>/` with three files:

- `claimed_at` — ISO-8601 UTC string produced by `date -u +%Y-%m-%dT%H:%M:%SZ`
- `claimed_by` — free-text session id (the caller passes `<session-id>`)
- `action` — free-text label (default `working`)

Claim semantics:
- Atomic acquisition via `mkdir` (`breeze-status-manager:177`) — the one
  process that wins the mkdir writes the three files; losers read the existing
  claim.
- Timeout: 300 s (`CLAIM_TIMEOUT=300` in `breeze-status-manager:29` and
  `claim_is_stale` check `service.rs:221` via `cleanup_expired_claims(..., 300)`).
- Stale claims (older than 300 s) can be overwritten by a new claimant
  (`breeze-status-manager:192-213`).
- Cleanup path: `fetcher.rs:659-688` walks `~/.breeze/claims/`, parses each
  `claimed_at` via `parse_github_timestamp_epoch`, and `rm -rf`'s directories
  older than 300 s.

## 4. `~/.breeze/runner/runtime/status.env`

Key=value file (see `util.rs` `parse_kv_lines` / `write_lines`). Written by
`Service::refresh_runtime` every loop tick (`service.rs:944-994`) and read at
startup (`service.rs:92-99`).

Keys observed:
- `last_poll_epoch` — unix seconds
- `last_identity` — `<login>@<host>`
- `allowed_repos` — comma-separated or `"all"`
- `active_tasks` — integer count
- `queued_tasks` — integer count
- `last_note` — free-text, multiline-encoded (`util::encode_multiline`)
- `active_titles` — `;`-separated `<task_id>:<encoded-title>`
- `next_search_reconcile_epoch` — unix seconds
- `last_poll_warning` — free-text, multiline-encoded

Atomicity: `write_lines` → `write_text` → plain `fs::write` — not atomic. A
concurrent reader could theoretically see a partial file. In practice only one
process writes; readers that fail to parse a line simply drop it.

## 5. `~/.breeze/runner/threads/<stable-file-id>.env`

Per-thread bookkeeping for dispatcher de-duplication / retry. Keys defined
in `task.rs:156-209` (`ThreadRecord`):

- `thread_key` (multiline-encoded) — canonical API path, e.g. `/repos/o/r/pulls/12`
- `repo` (multiline-encoded) — `owner/name`
- `last_seen_updated_at` (multiline-encoded) — GitHub timestamp most recently observed
- `last_handled_updated_at` (multiline-encoded) — timestamp at which we last marked handled/skipped
- `last_result` (multiline-encoded) — `"handled" | "skipped" | "failed" | ...`
- `failure_count` — u32
- `next_retry_epoch` — u64 seconds; 0 if immediate
- `last_task_id` (multiline-encoded) — most recent task id for this thread

Filename is `stable_file_id(thread_key).env` — a hash so `/` in paths doesn't
break the filesystem (`store.rs:49-51`). Reader: `load_thread_record`
(`store.rs:53-70`). Writer: `save_thread_record` (`store.rs:72-74`).

## 6. `~/.breeze/runner/tasks/<task-id>/task.env`

Per-task metadata, also key=value (`store.rs:80-98`). Task id format is
`task-<epoch>-<stable-id>` (`service.rs:684`). Keys written by the dispatcher
(`service.rs:717-752`, completion at `884-930`, setup-failure at `813-856`):

- `task_id`
- `status` — `"running" | "handled" | "skipped" | "failed" | "simulated" | "orphaned"`
- `repo`, `workspace_repo`, `thread_key`, `title`, `kind`, `reason`
- `workspace_path`, `mirror_dir`, `repo_url`, `snapshot_dir`, `gh_shim_dir`
- `started_at` (epoch seconds)
- `finished_at` (epoch seconds, absent while running)
- `updated_at` (original GitHub timestamp)
- `source` — `"notifications" | "review-search" | "assigned-search" | "recovered-running"`
- `runner` — `"codex" | "claude"` (the runner that actually won)
- `summary` — multiline-encoded free-text
- `runner_output_path`

On startup the dispatcher scans these dirs (`service.rs:570-641`) to recover
any task left in `status=running` from a prior crashed run: it rewrites such
tasks to `status=orphaned` and re-enqueues them.

Workspaces referenced by `workspace_path` get GC'd after
`workspace_ttl_secs` (default 3 days) by `Store::cleanup_old_workspaces`
(`store.rs:127-179`).

## 7. `~/.breeze/runner/locks/<host>__<login>__<profile>/lock.env`

`LockInfo` (`lock.rs:10-56`). Keys:

- `pid` — u32
- `host`, `login`, `profile` — strings
- `heartbeat_epoch`, `started_epoch` — u64
- `active_tasks` — usize
- `note` (multiline-encoded)

Acquisition uses `mkdir` for atomic exclusion (`lock.rs:75-103`). Heartbeat is
refreshed every loop iteration via `refresh()`. A lock is considered stale if
`now - heartbeat_epoch > 20*60` **or** `kill -0 pid` fails (`lock.rs:174-185`).
Lock dir is removed on `Drop` (`lock.rs:133-137`) — i.e. only on clean exit.

## 8. `~/.breeze/runner/broker/`

The broker is the process-local `gh` serializer (see doc #4). Filesystem
contract:

- `broker/bin/gh` — POSIX shim script, written at startup (`broker.rs:35`) with
  mode `0o755`. The script source is `SHIM_SCRIPT` (`broker.rs:390-446`). It
  serializes `gh` calls from runner subprocesses by dropping a request dir and
  polling for a response.
- `broker/requests/req-<epoch>-<pid>-<suffix>/`
  - `cwd.txt`, `argv.txt` (one arg per line), `gh_host.txt` (optional),
    `gh_repo.txt` (optional) — written by the shim.
  - `stdout.txt`, `stderr.txt`, `response.env` — written by the broker.
    `response.env` is the sentinel the shim polls for (keys: `status_code`,
    `stdout_path`, `stderr_path`, `completed_at_ms`).
  - The shim `rm -rf`'s its own request dir after reading the response
    (`broker.rs:444`). On start, the broker also purges any leftover request
    dirs (`broker.rs:61-66`).
- `broker/history/<stable-id>/` — mutation response cache, TTL 15 min
  (`broker.rs:220`). Files: `stdout.txt`, `stderr.txt`, `response.env` (keys
  `status_code`, `completed_at_ms`). Used for idempotent replay of mutating
  `gh` commands (see `mutation_fingerprint`, `broker.rs:222-272`).

## 9. `~/.breeze/runner/logs/`

`breeze-runner-<epoch>.log` per start (`service.rs:260-261`). Receives the
merged stdout+stderr of the background process.

## 10. `~/.breeze/runner/launchd/`

macOS only. Single file `com.breeze.runner.<sanitized-login>.<sanitized-profile>.plist`
(`service.rs:1073-1086, 1176-1206`). Not atomic; overwritten on each
`start_with_launchctl`.

## 11. Who-writes-what matrix

| Path                                          | Writer(s)                                           | Readers |
|-----------------------------------------------|-----------------------------------------------------|---------|
| `~/.breeze/inbox.json`                        | Rust `Fetcher::poll_once` (atomic); **also** `bin/breeze-status-manager` optimistic `jq` rewrite; **also** legacy `bin/breeze-poll` | HTTP `/inbox`, dashboard, `bin/breeze-status-manager`, statusline, `/breeze` skill |
| `~/.breeze/activity.log`                      | Rust fetcher (append); `bin/breeze-status-manager` (append); legacy `bin/breeze-poll` (append) | HTTP `/activity`, SSE, `bin/breeze-watch` |
| `~/.breeze/claims/`                           | `bin/breeze-status-manager`                         | Rust `cleanup_expired_claims`, `get` in status-manager |
| `~/.breeze/runner/runtime/status.env`         | Rust `Service::refresh_runtime`                     | Rust bootstrap, `breeze-runner status` |
| `~/.breeze/runner/threads/*.env`              | Rust `Store::save_thread_record`                    | Rust `Store::load_thread_record` |
| `~/.breeze/runner/tasks/*/task.env`           | Rust dispatcher / completion handler                | Rust `list_task_metadata`, `cleanup_old_workspaces` |
| `~/.breeze/runner/locks/*/lock.env`           | Rust `ServiceLock::refresh`                         | `find_lock` readers, `breeze-runner status|stop` |
| `~/.breeze/runner/broker/bin/gh`              | Rust at broker start                                | Runner subprocesses (execve) |
| `~/.breeze/runner/broker/requests/*/`         | Shim (inputs) + Rust broker (outputs)               | Each other — cross-process IPC |
| `~/.breeze/runner/broker/history/*/`          | Rust broker                                         | Rust broker (cache hit lookup) |
| `~/.breeze/runner/logs/*.log`                 | OS redirected stdout/stderr                         | Human / `tail -f` |

## 12. Atomicity summary

- **Atomic (tmp + rename):** only `inbox.json` (`fetcher.rs:594-597`). Good.
- **Best-effort (plain `fs::write`):** everything else, including all `.env`
  files and `activity.log`. Safe because there's one writer per file in the
  daemon, but the shared `inbox.json` has three potential writers (see 11).
- **Atomic (mkdir):** lock directories (`lock.rs:75`) and claim directories
  (`breeze-status-manager:177`).

The TS port should:
1. Keep the atomic rename for `inbox.json`.
2. Document the mkdir-based locking / claiming contract (cross-process).
3. Decide whether to treat `bin/breeze-status-manager` and `bin/breeze-poll`
   as still-shipped or deprecated. Their writer access to `inbox.json` and
   `activity.log` is a compatibility constraint if they stay.

## 13. Unverified / needs human input

- Exact JSON key ordering in `inbox.json` is load-bearing for the legacy
  status-manager's `jq` queries (it does `.id` and `.breeze_status` lookups
  which are key-agnostic, so this is probably fine). Phase 3 should grep
  external consumers (the `/breeze` skill) for any ordered iteration.
- Whether any downstream consumer relies on `priority` being `int64`
  specifically (Rust encodes as `Number(i64)`). JS will round-trip fine under
  2^53, which is far beyond any realistic value.
- The encoder escapes all control characters `< 0x20` via `\uXXXX`
  (`json.rs:87-89`). Titles containing control chars will look escaped. No
  test confirms this survives the HTTP passthrough.
