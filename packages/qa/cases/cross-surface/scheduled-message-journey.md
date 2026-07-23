---
id: scheduled-message-journey
description: Validate scheduled job create, trigger materialization, backlog skip, owner pause, and chat-delete auto-pause across CLI, server, and web read surfaces.
areas: [cross-surface]
surfaces: [cli, client, server, web]
---

# Scheduled Message Journey

## Goal

Confirm that an agent can preview and create a cron job in the control chat,
the server worker materializes exactly one trigger message per due occurrence,
backlog skips hold while the prior trigger is unacked, owners can pause/resume
via CLI or web, and owner chat delete pauses active jobs before engagement is
deleted.

## Preconditions

- Deployment has `FIRST_TREE_CRON_JOBS_ENABLED=true` and
  `runtime.pollingIntervalSeconds` in 1..10.
- One human owner and one non-human agent in a flat control chat, both
  speakers, agent runtime connected with fresh heartbeats.
- Web desktop workspace access for the owner human.

## Steps (authoring stub — not executed in CI)

1. Agent runs `cron preview` then `cron create` with `-F` prompt; owner sees
   the job in Web Schedules sidebar and CLI `cron list`.
2. Force `next_run_at` due (or wait); verify one markdown trigger with trusted
   `cronTrigger` metadata and exactly one notify inbox row for the agent.
3. Leave trigger unacked; verify next tick skips with no second message.
4. ACK trigger; verify next future tick can accept again.
5. Owner `cron pause` / Web pause; verify worker does not materialize while
   paused; `cron resume` restores a future `nextRunAt`.
6. Owner deletes chat view; verify active jobs pause with
   `owner_chat_deleted` before engagement becomes deleted.

## Evidence

- Structured logs: `cron.occurrence.accepted`, `cron.occurrence.skipped`,
  `cron.job.auto_paused`.
- Chat message row + inbox entry status for the target agent only.
- API `outstanding` projection null after ACK.
