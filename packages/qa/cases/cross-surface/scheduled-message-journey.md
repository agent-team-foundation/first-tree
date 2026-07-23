---
id: scheduled-message-journey
description: Validate scheduled job create, trigger materialization, backlog skip, owner pause/resume/delete, timezone/DST, fail-closed authorization, and owner-scoped chat-delete pause across CLI, server, inbox, and web read surfaces.
areas: [cross-surface]
surfaces: [cli, client, server, web]
---

# Scheduled Message Journey

## Goal

Confirm that an agent can preview and create a cron job in the control chat,
the server worker materializes exactly one trigger message per due occurrence
into the ordinary Inbox path, backlog skips hold while the prior trigger is
unacked, owners can pause/resume/delete via CLI or web, nonexistent DST wall
times are skipped, unauthorized callers are fail-closed, and deleting one
owner's chat view pauses only that owner's active jobs.

Deterministic unit/integration tests own schemas, Croner/DST math, advisory
locking, and exact error envelopes. This case owns the live product loop:
CLI/API → worker → message → Inbox → provider reply → ACK, plus lifecycle and
multi-owner pause evidence on a real deployment.

## Preconditions

- Isolated run cell with candidate Server, PostgreSQL, Cron worker, bound
  Client/daemon, and candidate CLI. Prefer a combined Backend+Web tree when
  Web Schedules evidence is in scope.
- Deployment has `FIRST_TREE_CRON_JOBS_ENABLED=true` and
  `FIRST_TREE_POLLING_INTERVAL_SECONDS` in `1..10`.
- One human owner and one non-human agent in a flat control chat, both
  speakers; agent runtime connected with fresh heartbeats and a
  `one-turn-ready` provider when reply/ACK evidence is required.
- For multi-owner pause: a second human owner who is also a speaker and can
  own a distinct schedule in the same chat.
- Web desktop workspace access for the owner human when Schedules sidebar
  evidence is required. Mobile Cron management is out of scope for V1.

## Operate

- `operate cli`: from the bound agent session (`FIRST_TREE_CHAT_ID` set), run
  `cron preview` then `cron create` with a `-F` prompt (byte-preserving). Do
  not invent `--agent`, `--force`, `--yes`, or run-now flags. Confirm the job
  via `cron list` / `cron show`.
- `operate http-api` / worker: force `next_run_at` due (or wait) so the worker
  accepts one occurrence; leave that trigger unacked for one later tick, then
  ACK it; exercise a later future tick after ACK.
- `operate cli` / web: owner `cron pause` (or Web Pause), confirm no further
  materialization while paused, then `cron resume` (or Web Resume with a fresh
  preview) and confirm the restored `nextRunAt` does not replay missed
  occurrences.
- `operate cli`: owner `cron delete` after a successful trigger; confirm hard
  delete and that accepted messages/ACK history remain.
- `operate multi-owner`: with two owners' active jobs in the same chat, delete
  only owner A's chat view (engagement → deleted). Do not delete owner B's
  view in the same step.
- `operate timezone`: preview/create schedules that hit spring-forward gaps and
  autumn overlaps in real IANA zones (for example America/New_York,
  Europe/London); also try an invalid timezone and an invalid schedule.
- `operate fail-closed`: attempt ordinary-message forgery of `cronTrigger`
  metadata, stale `If-Match`, same-name divergent create, and mutate after
  manager reassignment / non-speaker / deleted engagement when fixtures allow.
- `operate fault` (optional when multi-replica is available): run two workers
  against one due job and confirm a single accept.

## Observe

- `observe http-api` / db: exactly one accepted occurrence per due fire → one
  unique run key, one markdown trigger with trusted `cronTrigger` metadata,
  one `notify=true` inbox row for the target agent. Unacked backlog produces
  skip telemetry without a second message; ACK unlocks a later accept.
- `observe runtime-event`: Inbox/WS delivery wakes the bound agent; after a
  provider reply the trigger is ACKed (durable at-least-once semantics). If no
  provider is `one-turn-ready`, stop at delivery evidence and classify the
  model turn as `BLOCKED`, not a product `FAIL`.
- `observe cli` / web: pause stops future accepts; resume restores a future
  `nextRunAt` without backfill; Schedules sidebar (when in scope) shows
  read-only schedule detail for readers and lifecycle controls only for the
  owner.
- `observe multi-owner`: after owner A deletes their chat view, only A's
  active jobs pause with `owner_chat_deleted`; owner B's schedules remain
  active and may still fire. A's sticky-deleted chat view does not auto-restore
  when B's (or any) new trigger lands.
- `observe errors`: invalid timezone → `CRON_JOB_INVALID_TIMEZONE`; invalid
  schedule → `CRON_JOB_INVALID_SCHEDULE`; stale revision →
  `CRON_JOB_REVISION_MISMATCH`; unauthorized mutate → `CRON_JOB_FORBIDDEN`;
  reserved metadata → `CRON_TRIGGER_METADATA_RESERVED`.
- `observe timezone`: spring-forward nonexistent wall times are skipped (not
  shifted); autumn overlap fires once at the earlier instant.
- `observe logs` (when available): `cron.occurrence.accepted`,
  `cron.occurrence.skipped`, `cron.job.auto_paused`.

## Expected Result

`PASS`: preview/create works through the First Tree `cron` namespace; each due
occurrence materializes exactly once into the ordinary Chat+Inbox path; pause
blocks future accepts only; resume does not replay misses; delete is
irreversible while preserving accepted work; owner chat delete pauses only that
owner's active jobs; sticky-deleted views stay deleted on new triggers; DST and
fail-closed branches match the observe list.

`FAIL`: duplicate materialization, provider-native scheduler fallback used as
the product path, pause canceling already accepted/delivered/running work,
chat delete pausing another owner's schedules, sticky-deleted view auto-restored
by a cron trigger, or stable product error codes missing on the fail-closed
branches above.

`BLOCKED`: run cell cannot enable the kill switch / cadence gate, cannot bind a
runtime, or (for reply/ACK extension) no provider is `one-turn-ready`.

`INCONCLUSIVE`: delivery or lifecycle evidence is partial, unstable, or not
attributable to the target refs.

## Evidence

Keep redacted CLI JSON for preview/create/list/show/pause/resume/delete, the
trigger message id + run key, inbox row status for the target agent, worker or
structured-log lines for accept/skip/auto-pause, multi-owner state after chat
delete, and timezone preview samples. Do not retain tokens or full private
prompts beyond what the run needs.
