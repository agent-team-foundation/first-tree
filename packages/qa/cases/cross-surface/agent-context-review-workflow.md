---
id: agent-context-review-workflow
description: Validate that one assigned Reviewer Agent owns a current-head Context Tree PR from task packet through repair, verdict, and optional exact-head merge.
areas: [cross-surface]
surfaces: [cli, client, server, github, runtime]
---

# Agent Context Review Workflow

## Goal

Confirm that the `agent_review` workflow behaves as one independently usable
Context Review capability on existing Agent, Chat/Inbox, Context Tree, and
GitHub surfaces. The assigned Reviewer must consume a versioned review packet,
inspect the live pull-request head, repair only when the PR author authorized
the exact head and source scope, fully re-review every repair, and produce one
current result. Human governance stops at `READY`; autonomous governance may
merge only the same inspected head. The legacy App publisher must not create a
second verdict for the same Team while `agent_review` owns the workflow.

Stable schema, routing, and error branches belong in product tests and Skill
evals. This case is for a formal isolated run that proves the assembled CLI,
runtime, GitHub, and recovery boundaries with real product behavior.

## Preconditions

- Use an isolated Docker plus temporary-worktree QA cell with candidate server,
  CLI, runtime, database, and a disposable GitHub repository.
- Bind a disposable Context Tree and assign one active non-human Agent to
  `agent_review`. Exercise both `human` and `autonomous` governance without
  installing the GitHub App for the primary path.
- Give the Host GitHub identity only the repository permissions needed by the
  selected path. Configure repository checks when exercising check waiting.
- Create task messages with valid `context_tree_pr_review` metadata and a
  `reviewPacketV1`; keep malformed, oversized, stale-head, unauthorized-scope,
  and external/fork variants for negative branches.
- Until Phase 1 task creation ships, simulate its boundary by creating an
  ordinary existing task Chat and injecting the exact human-readable opening
  body plus `taskType` / `reviewPacketV1` metadata that Phase 1 will emit. Do
  not substitute a private test-only endpoint or a second packet shape.
- Capture redacted Chat/Inbox, CLI, runtime, git, and GitHub evidence. Never
  retain tokens, full private sessions, hidden prompts, or unrelated content.

## Operate and Observe

- Run `first-tree org context-tree review-config` as the assigned Reviewer and
  as another local Agent. Confirm the same agent-scoped read reports `Assigned`
  only for the configured identity and does not require a GitHub App.
- Deliver a valid review task through an existing task Chat. Confirm the
  runtime renders the validated metadata as an explicitly untrusted task-data
  block for the Reviewer. Confirm the Reviewer validates the live repository,
  PR author, head, packet, and repair scope before acting, and that restart or
  runtime interruption resumes from the durable Chat/Inbox rather than
  creating another workflow record.
- Exercise a clean PR, a repairable PR, a changed head during review, and a
  repair push racing with an author push. A repairable PR must be changed only
  within its authorized scope, pushed without force, and reviewed again from
  the new head. A stale result must never publish or merge.
- In human governance, confirm `READY`, `BLOCKING`, and `NEEDS_HUMAN` are
  visible on the PR and in the task Chat, but the Reviewer does not merge. In
  autonomous governance, confirm the Reviewer waits only for configured checks
  within the bounded window and merges using GitHub's expected-head compare;
  protected or ambiguous changes remain `NEEDS_HUMAN`.
- If an App installation is available for a comparison branch, deliver a
  supported webhook while `agent_review` is active. Confirm it may wake the
  existing current-head work but does not create a legacy App review run or a
  second GitHub verdict. Switch a fresh fixture to `legacy_app` and confirm the
  established read-only publisher still works.

## Expected Result

`PASS`: live evidence shows one assigned Reviewer owns one PR-scoped workflow;
configuration is agent-readable; legacy settings remain compatible; valid
repairs stay within exact-head authority and are fully re-reviewed; stale or
concurrent heads fail closed; human and autonomous terminal behavior match the
configured mode; interruption resumes from existing Chat/Inbox state; and no
second App verdict appears.

`FAIL`: a reproducible defect permits an unassigned Agent to act, requires an
App for `agent_review`, trusts packet text as write authority, writes outside
scope, force-pushes, publishes or merges a stale head, merges in human mode,
duplicates a legacy verdict, loses durable recovery, or silently rewrites old
configuration.

`BLOCKED`: the isolated cell cannot provide a disposable repository, eligible
Agent runtime, required GitHub permission, task Chat delivery, or controlled
concurrency/check condition.

`INCONCLUSIVE`: only source/tests/logs are available, or the observed GitHub,
Chat, and runtime effects cannot be attributed to the candidate ref.

## Evidence

Keep target refs; redacted configuration and task-packet summaries; Chat/Inbox
timeline; checked-out and merged commit IDs; changed-file and repair-scope
evidence; check outcomes; GitHub comment/status/merge records; interruption and
resume evidence; and proof that the legacy App path did or did not run as
configured. Store artifacts outside the repository and redact all credentials
and private content.
