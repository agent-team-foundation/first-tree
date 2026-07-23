---
id: scheduled-message-journey
description: Validate scheduled job create, trigger materialization, backlog skip, owner pause, DST skip, fail-closed authorization, and chat-delete auto-pause across CLI, server, and web read surfaces.
areas: [cross-surface]
surfaces: [cli, client, server, web]
---

# Scheduled Message Journey

## Goal

Confirm that an agent can preview and create a cron job in the control chat,
the server worker materializes exactly one trigger message per due occurrence,
backlog skips hold while the prior trigger is unacked, owners can pause/resume
via CLI or web, nonexistent DST wall times are skipped, unauthorized callers
are fail-closed, and owner chat delete pauses active jobs before engagement is
deleted.

## Preconditions

- Deployment has `FIRST_TREE_CRON_JOBS_ENABLED=true` and
  `runtime.pollingIntervalSeconds` in 1..10.
- One human owner and one non-human agent in a flat control chat, both
  speakers, agent runtime connected with fresh heartbeats.
- Web desktop workspace access for the owner human.

## Steps (authoring — expand locally; not executed in CI)

### Happy path

1. Agent runs `cron preview` then `cron create` with `-F` prompt (byte-preserving);
   owner sees the job in Web Schedules sidebar and CLI `cron list`. No `--agent`,
   `--force`, or `--yes` flags exist.
2. Force `next_run_at` due (or wait); verify one markdown trigger with trusted
   `cronTrigger` metadata and exactly one notify inbox row for the agent.
   Multi-replica workers produce exactly one accept.
3. Leave trigger unacked; verify next tick skips with no second message.
4. ACK trigger; verify next future tick can accept again.
5. Owner `cron pause` / Web pause; verify worker does not materialize while
   paused; `cron resume` restores a future `nextRunAt` without replaying misses.
6. Owner deletes chat view; verify active jobs pause with
   `owner_chat_deleted` before engagement becomes deleted; restore never
   auto-resumes.

### Fail-closed / limitation branches

7. Forge ordinary-message `cronTrigger` metadata → `CRON_TRIGGER_METADATA_RESERVED`.
8. Invalid timezone preview → `CRON_JOB_INVALID_TIMEZONE`; invalid schedule /
   `+MON` / `+9` → `CRON_JOB_INVALID_SCHEDULE`.
9. Stale `If-Match` → `CRON_JOB_REVISION_MISMATCH`; same-name divergent create →
   `CRON_JOB_NAME_CONFLICT`; identical concurrent create → same job id.
10. Former manager after reassignment, non-speaker owner, and deleted engagement
    cannot create/PATCH/DELETE (`CRON_JOB_FORBIDDEN`).
11. Spring-forward nonexistent wall times (NY `0 2 8 3 *`, London `0 1 29 3 *`)
    are skipped, not shifted; autumn overlap fires once.
12. Malformed persisted schedule auto-pauses with `invalid_schedule` and does
    not starve later due jobs.
13. CLI/agent lifecycle mutations emit `chat:updated` so Web invalidates schedules.
14. Already-active `{state:"active"}` and prompt-only edits keep `nextRunAt`
    stable; compound pause still applies field changes.

## Evidence

- Structured logs: `cron.occurrence.accepted`, `cron.occurrence.skipped`,
  `cron.job.auto_paused`.
- Chat message row + inbox entry status for the target agent only.
- API `outstanding` projection null after ACK.
- Stable error `code` fields on every fail-closed branch above.
- Unit/integration: `cron-schedule.test.ts`, `cron-jobs.integration.test.ts`,
  shared schema tests, briefing compactness.
