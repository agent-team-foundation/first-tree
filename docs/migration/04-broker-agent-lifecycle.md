# 04 — Broker and Agent Lifecycle

Source of truth:
- `first-tree-breeze/breeze-runner/src/service.rs` (1408 lines — main loop,
  dispatch, lock, completion, launchd integration)
- `first-tree-breeze/breeze-runner/src/runner.rs` (305 lines — per-agent
  subprocess, prompt template, result parsing)
- `first-tree-breeze/breeze-runner/src/broker.rs` (539 lines — cross-process
  `gh` serializer and mutation cache)
- `first-tree-breeze/breeze-runner/src/gh_executor.rs` (303 lines — rate
  limiter and `command_is_mutating` classifier)
- `first-tree-breeze/breeze-runner/src/lock.rs` (209 lines — service lock)
- `first-tree-breeze/breeze-runner/src/config.rs` — governing config keys
- `first-tree-breeze/breeze-runner/src/classify.rs` — `TaskKind`, priority
- `first-tree-breeze/breeze-runner/src/workspace.rs` — git worktree setup

The term "broker" here refers to two distinct things in the Rust code:

1. **`GhBroker`** (`broker.rs`) — a cross-process serializer for `gh` CLI
   calls. It is NOT the thing that decides which notifications to act on. It
   exists so the agent subprocess can still shell out to `gh` under a single
   rate-limited writer.
2. **The dispatcher in `Service::run_loop`** (`service.rs:443-501`) — the loop
   that polls GitHub, picks candidates, and launches agent subprocesses. This
   is what most people mean when they say "the broker fires".

Both are covered below.

## 1. Process model at steady state

A single `breeze-runner` process owns:

- A main thread running `Service::run_loop` (`service.rs:443-501`) — the
  dispatcher.
- A background `Inbox poll loop` thread started by `spawn_inbox_poll_loop`
  (`service.rs:372-411`) — refreshes `~/.breeze/inbox.json` every
  `inbox_poll_interval_secs` (default 60 s).
- A background `HTTP/SSE server` thread started by `spawn_http_server`
  (`service.rs:413-429`) — serves `:7878`.
- A background `Gh broker` thread started by `GhBroker::start`
  (`broker.rs:57-76`) — drains `~/.breeze/runner/broker/requests/` and invokes
  real `gh`.
- Short-lived runner threads (`service.rs:767-799`) — one per active task.
  Each blocks on `Command::new("codex" | "claude").status()` until the agent
  exits.

Single lock `~/.breeze/runner/locks/<host>__<login>__<profile>/lock.env`
excludes a second `breeze-runner` process for the same identity (see doc #2
§7 and `lock.rs`).

## 2. When does the dispatcher fire?

`run_loop` (`service.rs:443-501`) runs a tight loop:

1. Verify the gh identity hasn't changed (`verify_identity`, `service.rs:503-513`).
2. Refresh `runtime/status.env` for the statusline.
3. If `did_poll` is false:
   - Re-enqueue any orphaned `status=running` tasks from previous runs
     (`enqueue_recoverable_tasks`, `service.rs:570-641`).
   - Call `poll_candidates` (`service.rs:515-542`) → `GhClient::collect_candidates`
     (`gh.rs:247-300`). This fetches notifications and (on the reconcile
     schedule) search results.
   - Filter via `should_schedule` (`service.rs:643-672`) and enqueue.
   - Set `did_poll = true`.
4. Dispatch as many pending candidates as `max_parallel` allows
   (`dispatch_pending`, `service.rs:674-811`).
5. Wait on the completion channel with a timeout:
   - If `once == true` and nothing is pending/active: break out of the loop.
   - If `active.is_empty()`: wait `poll_interval_secs` (default **600 s**).
   - Else: wait 2 s.
6. If the timeout fires and `once == false`, set `did_poll = false` so the
   next iteration polls again.
7. Drain completions via `handle_completion` (`service.rs:879-942`).

Key intervals (`config.rs` defaults):

- `poll_interval_secs` = 600 (10 min) — dispatcher idle tick when no active
  tasks.
- `inbox_poll_interval_secs` = 60 — inbox refresh tick (separate thread).
- `search_reconcile_interval_secs` = 6 h — how often `include_search=true` is
  set on `collect_candidates`. When rate-limited this grows to 15 min
  (`service.rs:526-530`).
- `notification_lookback_secs` = 24 h — notifications older than this are
  dropped (`gh.rs:287-289`).
- `task_limit` = 100 — search API `--limit` per source.

So: **the dispatcher polls every 10 minutes when idle, and every 2 s when at
least one agent is running (to drain completions promptly). The inbox refresh
is independent at 60 s.**

There is no state-change trigger: a status transition written by the
status-manager does NOT kick the dispatcher; it only updates `inbox.json` for
the statusline. The dispatcher's notion of work comes from the GitHub
`/notifications` API, not from local labels.

## 3. What exactly does the dispatcher dispatch?

For each poll the Rust client returns zero or more `TaskCandidate` objects
from three sources (`gh.rs:247-300`):

| Source              | gh call                                                  | Task kind candidates |
|---------------------|----------------------------------------------------------|----------------------|
| `notifications`     | `gh api /notifications?all=true&participating=false&per_page=100 --paginate` | Review, Mention, Comment, Assigned{Issue,PR}, Discussion (via `classify_notification`, `classify.rs:70-90`) |
| `review-search`     | `gh search prs --review-requested=@me --state open ...`  | `ReviewRequest` only |
| `assigned-search`   | `gh search issues --assignee=@me --state open --include-prs` | `AssignedIssue` or `AssignedPullRequest` |

The last two are rate-limited and only run every
`search_reconcile_interval_secs`.

`should_process_reason` (`classify.rs:39-50`) filters notification reasons:
only `review_requested`, `comment`, `mention`, `team_mention`, `assign`,
`author`, `manual` are actionable. Reasons like `subscribed`, `ci_activity`
are ignored, even though they appear in the inbox display.

### Candidate priority (`classify.rs:52-68`)

This is the **dispatcher** priority (higher = dispatched first), distinct
from the inbox-display `priority` in doc #2.

| Kind                           | Priority |
|--------------------------------|----------|
| `ReviewRequest`                | 100      |
| `Mention`                      | 95       |
| `Discussion`                   | 90       |
| `Comment`                      | 85       |
| `AssignedPullRequest`          | 80       |
| `AssignedIssue`                | 70       |
| `Other`                        | 50 (100 if reason == review_requested) |

Candidates are sorted by priority desc, then `updated_at` desc, then
`thread_key` asc (`gh.rs:291-297`).

### Filtering before dispatch (`should_schedule`, `service.rs:643-672`)

For each candidate the dispatcher:

1. Loads the `ThreadRecord` for the `thread_key` (see doc #2 §5). Updates
   `last_seen_updated_at`, saves it back.
2. Skips if `next_retry_epoch > now` (back-off window still active).
3. Skips if `candidate.updated_at <= last_handled_updated_at` (already
   handled at this timestamp).
4. Fetches `latest_visible_activity` (`gh.rs:235-245`) — inspects latest
   comment + latest review timestamp. If the latest activity on the thread
   was by the current login and it post-dates the candidate's `updated_at`,
   skip and mark the thread as `last_result=skipped`
   (`should_ignore_latest_self_activity` in `gh.rs`).

## 4. What gets dispatched to the agent subprocess?

For each selected candidate (`dispatch_pending`, `service.rs:674-811`):

1. Generate task id: `task-<epoch>-<stable-id>` (`service.rs:684`).
2. Create `~/.breeze/runner/tasks/<task-id>/`.
3. Hydrate the snapshot via `gh.rs:302-479`. This writes 1–5 JSON files into
   `<task-dir>/snapshot/` depending on the subject type:
   - Always: `task-summary.env`, `README.txt`, `subject.json`, optionally
     `latest-comment.json`
   - PR: `pr-view.json`, `pr.diff`, `issue-comments.json`, `pr-reviews.json`
   - Issue: `issue-view.json`, `issue-comments.json`
4. Possibly reroute the candidate's `workspace_repo` to the operator's
   self-repo if the discussion is about configuring breeze-runner itself
   (`route_workspace_candidate` + `should_route_to_operator_repo`,
   `service.rs:859-877, 1313-1340`). Heuristic: text contains both a
   "change-requesting" verb and a user-targeting phrase, AND mentions
   `breeze-runner`.
5. `WorkspaceManager::prepare` (`workspace.rs:35-81`):
   - Ensures a bare mirror at `~/.breeze/runner/repos/<slug>.git`.
   - Fetches `refs/pull/<n>/head` into `refs/remotes/origin/breeze-runner-pr-<n>`
     when the candidate is a PR; otherwise uses the mirror's `HEAD`.
   - Creates a detached-HEAD worktree at
     `~/.breeze/runner/workspaces/<slug>/<kind>-<stable-id>`.
   - Seeds local `user.name = "<login> via breeze-runner"` and
     `user.email = "<login>@users.noreply.github.com"`.
6. Pick runner: `runners.execution_order()` (`runner.rs:78-86`) returns the
   configured runner list rotated by a counter, so Codex and Claude alternate
   across tasks when both are available. The first runner is "selected", the
   rest are fallbacks tried in order on failure.
7. Write `tasks/<task-id>/task.env` with `status=running`, the chosen runner
   name, and all the metadata in doc #2 §6.
8. Spawn a thread running `execute_task(runners, request)`
   (`service.rs:767-799`, `service.rs:1254-1280`). Each runner in the list is
   attempted until one returns `Ok`; otherwise a combined failure is reported.

### The agent subprocess

`RunnerSpec::execute` (`runner.rs:88-170`) builds the prompt, writes it to
`<task-dir>/prompt.txt`, and execs:

**Codex path** (`runner.rs:105-127`):
```
codex exec \
  --cd <workspace_dir> \
  --dangerously-bypass-approvals-and-sandbox \
  --output-last-message <task-dir>/runner-output.txt \
  [--model <codex_model>] \
  <task-dir>/prompt.txt
```
stdin = null, stdout → `runner-stdout.log`, stderr → `runner-stderr.log`.
Env:
- `PATH` = `<gh_shim_dir>:<existing PATH>` (the broker shim comes first)
- `BREEZE_BROKER_DIR = ~/.breeze/runner/broker`
- `BREEZE_SNAPSHOT_DIR = <task-dir>/snapshot`
- `BREEZE_TASK_DIR = <task-dir>`

**Claude path** (`runner.rs:128-150`):
```
cd <workspace_dir>
claude -p --permission-mode bypassPermissions [--model <claude_model>] "<prompt>"
```
Same env vars. stdout is captured to `runner-stdout.log` and then **copied
to** `runner-output.txt` (`runner.rs:146-148`) because Claude doesn't have a
`--output-last-message` flag.

In both cases the Rust thread blocks on `status()`. There is no per-task
timeout: if Codex or Claude hangs forever, the dispatcher thread for that
task hangs forever. See §8 for implications.

### Prompt contents (`runner.rs:172-231`)

The agent receives a templated prompt with:
- The agent's identity (`{git_id}` = active gh login).
- Breeze's own repo URL: `https://github.com/agent-team-foundation/breeze`.
- The task URL (comment-anchored when a comment is known, else PR/issue URL).
- Local context: `task_id`, `repo`, optional `working repository` (when the
  workspace was routed to the operator's self-repo), `kind`, `workspace
  path`, `snapshot_dir`, `task_dir`.
- A "don't stop until" list (read context, complete task, reply on GitHub).
- The label-setting rule covered in doc #3.
- A disclosure sentence the agent is required to include once in any public
  reply (the `BREEZE_DISCLOSURE` env var / `--disclosure` flag,
  `config.rs:195-198`).
- Instruction to end with `BREEZE_RESULT: status=<handled|skipped|failed>
  summary=<one-line>`.

The daemon parses the last `BREEZE_RESULT:` line via `parse_result`
(`runner.rs:233-260`). If none is found, the status defaults to `handled` and
the summary is the last line of output.

### Completion

`handle_completion` (`service.rs:879-942`):

- Removes the task from `active`.
- Updates `tasks/<task-id>/task.env` with final status, summary,
  runner_output_path, runner name.
- Updates the `ThreadRecord`:
  - On `handled` / `skipped`: sets `last_handled_updated_at`, resets
    `failure_count` and `next_retry_epoch`.
  - On `failed`: increments `failure_count`, sets `next_retry_epoch = now +
    retry_delay(failure_count)` where `retry_delay(n) = 60 * 2^min(n, 6)`
    seconds (`service.rs:1282-1285`), capped at `poll_interval_secs`
    (`service.rs:1209-1211`).
- If the completion channel reports an `Err(string)`: same as `failed` but
  writes the error string into `summary`.

## 5. Concurrency model

- Max concurrent tasks: `config.max_parallel` (default **20**; `config.rs:180,
  321`).
- The dispatcher's inner loop fills the active set up to the cap
  (`service.rs:681`), then waits for completions.
- Per-thread dedup: `queued_threads: HashSet<String>` keyed on
  `thread_key` prevents a single thread from being enqueued twice in the
  same pass (`service.rs:558-566`). The active set is also consulted
  (`service.rs:552-557`).
- Recovery on startup: tasks that are `status=running` from a previous
  process are renamed to `status=orphaned` and re-queued
  (`service.rs:570-641`). This is why there is a Phase 3 contract around
  single-ownership of `tasks/`.

There is **no claim-based exclusion across machines** (unlike the
user-facing `~/.breeze/claims/` dir, which is for the skill/statusline).
Running `breeze-runner` on two machines for the same gh login is prevented
only by the local `locks/` directory, which is per-machine. See §9.

## 6. The gh broker (cross-process `gh` serializer)

`GhBroker` (`broker.rs`) is the second meaning of "broker". It exists because
the agent subprocess needs to call `gh` (for comments, reviews, labels, PR
creation) but must share the same rate-limit budget as the daemon. The design:

1. The daemon writes a shim script at `~/.breeze/runner/broker/bin/gh` mode
   `0o755` (`broker.rs:35-44`). Source is `SHIM_SCRIPT` (`broker.rs:390-446`).
2. The agent subprocess has `PATH` prefixed with `broker/bin/` and
   `BREEZE_BROKER_DIR=~/.breeze/runner/broker` set (`runner.rs:99-103`).
3. When the agent runs `gh`, the shim is invoked instead.
4. The shim creates `$BREEZE_BROKER_DIR/requests/req-<epoch>-<pid>-<rand>/`,
   writes `cwd.txt`, `argv.txt` (one arg per line), and optionally
   `gh_host.txt`, `gh_repo.txt`. Then it polls for `response.env` every
   100 ms, with a default timeout of 1800 s (`BREEZE_BROKER_TIMEOUT_SECS`,
   exit 124 on timeout).
5. The broker thread (`serve_loop`, `broker.rs:96-126`) polls `requests/`
   every 100 ms, handles pending requests in sorted order.
6. For each request: `handle_request` (`broker.rs:145-211`) reconstructs a
   `GhCommandSpec`, checks the mutation-response cache, then runs real `gh`
   via `GhExecutor::run`.
7. The executor enforces rate limits (`gh_executor.rs:119-167`):
   - Per-bucket next-allowed timestamps (`Core`, `Search`, `Write`).
   - Write cooldown `gh_write_cooldown_ms` between mutating commands
     (default 1250 ms, `config.rs:189-190`).
   - On rate-limit detection (`is_rate_limited`, `gh_executor.rs:247-254`,
     scans for "secondary rate limit", "rate limit exceeded", etc.), sets
     `next_core_epoch_ms += 60_000 * 2^min(streak, 4)`.
   - Up to 3 attempts per call before giving up.
8. The broker writes the result to `stdout.txt`, `stderr.txt`, and
   `response.env` (`broker.rs:353-372`). The shim reads these, `rm -rf`s the
   request dir, and exits with the status code.
9. Successful mutations get cached in `history/<fingerprint-id>/` with a
   15-minute TTL (`broker.rs:220, 296-331`). The fingerprint normalizes
   `--body` / `--body-file` contents via `stable_file_id` so that retries
   with the same payload hit the cache even if the tmp file path is
   different (`broker.rs:222-272`). This is the idempotency layer — it
   prevents duplicate GitHub comments when an agent retries after a
   transient failure.

Mutation classification (`gh_executor.rs:181-245`): `command_is_mutating`
returns true for `issue comment/close/create/delete/edit/lock/pin/reopen/transfer/unlock/unpin`,
`pr close/comment/create/edit/merge/ready/reopen/review/update-branch`,
`label clone/create/delete/edit`, and for `gh api` calls with an explicit
non-GET `-X/--method` or with any `-f/-F/--field/--raw-field/--input` flag.

The broker is started inside `acquire_lock` (`service.rs:431-441`) and
stopped on `Drop`. It purges any leftover `requests/` on start
(`broker.rs:61-66`).

## 7. How does the dispatcher know when an agent job is done?

Per-task thread blocks on `Command::status()` → reads the status + the
`runner-output.txt` file → parses `BREEZE_RESULT` → sends a `TaskCompletion`
over an mpsc channel back to the main loop
(`service.rs:767-799`, `runner.rs:88-170`, `service.rs:483-496`).

There is **no polling of GitHub** to detect completion. The contract is
strictly: the agent exits, and the last `BREEZE_RESULT:` line dictates the
status. If the agent crashes without writing a `BREEZE_RESULT:` line, the
output file will not have one, and `parse_result` defaults to `("handled",
last_line)` — so a silent crash is indistinguishable from a success.

## 8. Failure handling

| Failure                                 | Handling                                                                 |
|-----------------------------------------|--------------------------------------------------------------------------|
| Setup error before agent launches (snapshot, workspace prep)     | `record_setup_failure` writes `status=failed` + summary, increments `failure_count`, schedules `next_retry_epoch` (`service.rs:813-857`) |
| `gh` identity changed mid-run           | `verify_identity` returns `Err`; loop exits (`service.rs:503-513`)       |
| Agent subprocess non-zero exit          | Current runner returns `Err`; next runner in `execution_order` is tried (`service.rs:1254-1280`); if all fail, task marked `failed` |
| Agent hangs forever                     | **Not handled.** The per-task thread blocks indefinitely on `.status()`. No per-task timeout in the code. This is a known gap for the TS port. |
| Agent crashes with no `BREEZE_RESULT:`  | Silently treated as `handled` with the last line of stdout as the summary (`runner.rs:233-260`). |
| Broker shim timeout (no response in 1800 s) | Shim exits 124 and stderr message (`SHIM_SCRIPT` at `broker.rs:424-430`). The agent sees this as a `gh` failure. |
| Rate-limit (secondary / abuse)          | Executor retries up to 3× with exponential back-off per bucket (`gh_executor.rs:69-85, 154-167`). After retries it returns the failing output; caller surfaces it. |
| Dispatcher process crash mid-task       | Next startup's `enqueue_recoverable_tasks` rewrites `status=running` tasks to `orphaned` and re-queues them (`service.rs:570-641`). |

## 9. Configuration surface

Breeze does not read a YAML file. All config is CLI flags and env vars,
resolved in `Config::parse` (`config.rs:140-311`). The spec question "which
`~/.breeze/config.yaml` keys govern broker behavior" has no answer in this
codebase: **there is no `~/.breeze/config.yaml`**. Phase 3 may introduce one,
but the Rust daemon today is configured only by:

Key knobs for broker/dispatcher behavior (default → env var → CLI flag):

| Config field                          | Default     | Env var                              | CLI flag                           |
|---------------------------------------|-------------|--------------------------------------|------------------------------------|
| `home`                                | `~/.breeze/runner` | `BREEZE_HOME`                 | `--home`                           |
| `host`                                | `github.com`| `BREEZE_HOST`                        | `--host`                           |
| `profile`                             | `default`   | `BREEZE_PROFILE`                     | `--profile`                        |
| `repo_filter`                         | empty (all) | `BREEZE_ALLOWED_REPOS` (CSV of `owner/repo` or `owner/*`) | `--allow-repo` |
| `runners`                             | `codex,claude` | `BREEZE_RUNNERS`                  | `--runner`                         |
| `max_parallel`                        | 20          | `BREEZE_MAX_PARALLEL`                | `--max-parallel`                   |
| `poll_interval_secs`                  | 600         | `BREEZE_POLL_INTERVAL_SECS`          | `--poll-interval-secs`             |
| `inbox_poll_interval_secs`            | 60          | `BREEZE_INBOX_POLL_INTERVAL_SECS`    | `--inbox-poll-interval-secs`       |
| `task_limit`                          | 100         | `BREEZE_TASK_LIMIT`                  | `--task-limit`                     |
| `notification_lookback_secs`          | 86_400      | `BREEZE_NOTIFICATION_LOOKBACK_SECS`  | `--notification-lookback-secs`     |
| `search_reconcile_interval_secs`      | 21_600      | `BREEZE_SEARCH_RECONCILE_INTERVAL_SECS` | `--search-reconcile-interval-secs` |
| `gh_write_cooldown_ms`                | 1250        | `BREEZE_GH_WRITE_COOLDOWN_MS`        | `--gh-write-cooldown-ms`           |
| `workspace_ttl_secs`                  | 259_200 (3d)| `BREEZE_WORKSPACE_TTL_SECS`          | `--workspace-ttl-secs`             |
| `codex_model`                         | none        | `BREEZE_CODEX_MODEL`                 | `--codex-model`                    |
| `claude_model`                        | none        | `BREEZE_CLAUDE_MODEL`                | `--claude-model`                   |
| `disclosure_text`                     | see below   | `BREEZE_DISCLOSURE`                  | `--disclosure`                     |
| `dry_run`                             | false       | `BREEZE_DRY_RUN`                     | `--dry-run` / `--no-dry-run`       |
| `http_port`                           | 7878        | `BREEZE_HTTP_PORT`                   | `--http-port`                      |
| `http_disabled`                       | false       | `BREEZE_HTTP_DISABLED`               | `--no-http`                        |

Default disclosure: `"Agent note: this reply was prepared and posted by breeze
running locally for the active account."` (`config.rs:195-198`).

Env vars additionally passed through to the launchd plist (`service.rs:1214-1228`):
`AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT_BACKUP`,
`AZURE_OPENAI_API_KEY_BACKUP`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`GH_TOKEN`, `GITHUB_TOKEN`, `CODEX_HOME`, `CLAUDE_CODE_USE_BEDROCK`,
`CLAUDE_CODE_USE_VERTEX`.

### How notifications are selected for auto-action

There is no config that maps "notifications of kind X → dispatch". The
selection is hard-coded:

- `should_process_reason` whitelist (`classify.rs:39-50`): only seven reasons
  are ever actionable. Everything else is ignored by the dispatcher (though
  still displayed in the inbox).
- `repo_filter` (per-account allow-list of `owner/repo` or `owner/*`
  patterns) is the only coarse knob. Anything outside the allowlist is
  dropped both in notifications and search phases.
- `dry_run` short-circuits the runner spawn (`service.rs:768-775`) and
  writes `status=simulated` — useful for verifying the dispatcher end-to-end
  without agent costs.
- There is no per-`TaskKind` disable; the only filter is the reason
  whitelist.

### `dry_run` behavior

When `dry_run=true`, the dispatcher still goes through snapshot + workspace +
`task.env=running` setup; only the `execute_task` call is replaced with a
synthetic `TaskExecutionResult { status: "simulated", summary: "dry-run
scheduled task" }` (`service.rs:768-775`). `runner-output.txt` is NOT
written in this case — the path is recorded but the file doesn't exist.

## 10. `start` / `run` / `run-once` commands

- `run` (and default with no args) → `run_forever` (`service.rs:355-366`).
  Acquires lock, spawns inbox/HTTP threads, runs `run_loop(once=false)`.
- `run-once` → `run_once` (`service.rs:350-353`). Single poll, drain
  queue, exit.
- `start` → `start_background` (`service.rs:255-348`). On macOS writes a
  launchd plist and bootstraps via `launchctl bootstrap gui/<uid>`; elsewhere
  spawns `nohup breeze-runner run ...`. Returns after confirming a live lock
  file (750 ms settle time).
- `stop` → `stop` (`service.rs:231-245`). On macOS first runs
  `launchctl bootout`; then `kill <pid>` from the lock file.
- `status` (`service.rs:145-195`) / `doctor` (`service.rs:107-143`) — read-only
  introspection on lock + runtime.
- `cleanup` (`service.rs:197-207`) — GCs stale workspaces via
  `Store::cleanup_old_workspaces`.
- `poll` (`service.rs:209-229`) — one-shot inbox refresh; no dispatch.

## 11. Unverified / needs human input

- **No per-task timeout.** Phase 3 should add one (likely
  `Command::spawn` + `wait_timeout`-style or explicit `SIGTERM` after N
  minutes). The Rust code does not do it today. The TS port should not
  ship without it; pick a default (e.g. 30 min) and make it configurable.
- **Silent crash → `handled`.** `runner.rs:253-259`: if the agent exits
  successfully but emitted no `BREEZE_RESULT:`, the status defaults to
  `handled` and the summary is the last stdout line. The TS port should
  consider logging a warning and/or defaulting to `failed` instead when
  exit status is 0 but `BREEZE_RESULT` is absent. This is a policy
  decision, not a straightforward migration.
- **`broker.rs:181-190` short-circuits a cached mutation response without
  invoking `gh` at all.** If the GitHub side has been rolled back or
  manually reverted in the 15-minute cache window, the cached success will
  hide that from the agent. This is a correctness-vs-idempotency trade-off
  and worth flagging during port review.
- **`runner.rs:144-148`** writes Claude's stdout verbatim to
  `runner-output.txt`, so it includes every intermediate line, not just the
  last assistant message. `parse_result` handles this by scanning bottom-up
  for `BREEZE_RESULT:`. Keep this behavior or unify across runners — the TS
  port may want Claude's structured output (`--output-format json`) once
  that's stable.
- **The launchd integration assumes macOS + `launchctl` + a gui domain.**
  For Linux we fall back to `nohup`. The TS port will likely want a unified
  process manager abstraction; systemd/launchd/`forever` are all candidates
  but none exist in the Rust code today.
- **`BREEZE_BROKER_TIMEOUT_SECS=1800`** is embedded in the shim script
  (`broker.rs:422`). A full 30-minute ceiling for any single `gh` call is
  generous; Phase 3 might expose it as a config knob.
