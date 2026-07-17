---
id: agent-context-review-workflow
description: Validate that one assigned Reviewer Agent owns a managed Context Tree PR from task packet through repair, complete successor review, and exact-head squash merge.
areas: [cross-surface]
surfaces: [cli, client, server, github, runtime]
---

# Agent Context Review Workflow

## Goal

Confirm that the assigned Reviewer Agent consumes one versioned task packet,
checks live binding/assignment and GitHub state, repairs only within the PR
author's declared scope, fully reviews every successor head, and exact-head
squash-merges only a confirmed `READY` head. Confirm the managed path works
without a GitHub App and that the legacy App publisher cannot add a second
verdict to a managed PR.

Deterministic schema, route, and Skill wording checks belong in product tests
and Skill evals. This case proves the assembled runtime, CLI, Chat/Inbox,
GitHub, concurrency, and recovery behavior.

## Preconditions

- Use an isolated Docker plus temporary-worktree QA cell with candidate server,
  web, CLI, client runtime, database, and a disposable GitHub repository.
- Bind a disposable Context Tree and create two active non-human Reviewer
  Agents, A and B. Assign A initially. Do not install the GitHub App for the
  primary path.
- Give the Host GitHub identity only ordinary branch/PR write and merge access;
  configure a disposable check for waiting/failure cases.
- Until the Write producer ships, create an ordinary task Chat and inject the
  exact `taskType = context_tree_pr_review` plus `reviewPacketV1` metadata that
  the producer contract defines. Do not use a private endpoint or another
  packet shape.
- Prepare clean, repairable, protected/out-of-scope, stale-head, author-race,
  malformed-packet, and disabled/reassigned fixtures.
- Store redacted evidence outside the repository.

## Operate and Observe

- Read `first-tree org context-tree review-config --json` as the assigned
  Reviewer and another Agent. Confirm only the assigned Agent reports
  `Assigned`, the repository/branch come from the same response, and no App is
  required.
- Deliver a valid task and confirm the client renders an explicitly untrusted
  task context. Confirm the Reviewer checks live binding, assignment, PR
  author/head/refs, managed marker, and repair scope before every mutation.
- Before first-use materialization, confirm the missing Context Tree path does
  not leak repeated Git `fatal` diagnostics; after materialization, confirm the
  tracker resumes and records real tree writes.
- For a repairable PR, confirm only in-scope files change, the push is
  fast-forward, the old result is discarded, and the entire successor head is
  verified and reviewed before `READY`.
- Race an author push with review and with repair push. Confirm stale work never
  updates the current-head comment/status or merges.
- Disable or reassign the Reviewer before edit, push, projection, and merge.
  Confirm each old turn stops. If configuration races an already-issued GitHub
  merge request, record GitHub's actual result and the documented admin
  keep-or-revert handoff instead of claiming atomic cancellation.
- Exercise clean checks, failed checks, and checks exceeding the bounded wait.
  Confirm only a current-head `READY` with passing checks invokes
  `gh pr merge --match-head-commit ... --squash`; no `APPROVE`, `--auto`,
  `--admin`, force push, alternate merge method, watcher, or job is used.
- Restart the runtime after delivery and after a repair push. Confirm recovery
  comes from Chat/Inbox, live PR state, canonical marker/status, and worktree
  registry without duplicate results.
- Hold one clean same-head PR open after A publishes `READY`. Change the live
  assignment to B and wake B in the same durable PR Chat. Confirm B sees the
  takeover/history but does not inherit A's marker, status, or `READY`; B must
  complete a fresh live-head review and publish a result identified by the same
  Chat, B's Agent UUID, and the inspected head.
- On that unchanged head, switch B back to A and wake A in the same Chat.
  Confirm A may reuse only A's own fresh same-head terminal result, never B's.
  Repeat delivery and interrupt assignee reconciliation to confirm retries
  create no second Chat, duplicate takeover result, or duplicate active wake.
- Exercise same-Reviewer freshness on an unchanged head. After A publishes
  `READY`, separately add new substantive evidence, a blocking finding, a human
  decision, and a managed declaration/repair-scope change after the terminal
  result. Confirm each prevents reuse and merge; A must fully review again or
  produce `NEEDS_HUMAN` for protected/ambiguous input. Confirm a pure duplicate
  wake or status reflection does not invalidate an otherwise fresh result.
- Put A's matching terminal result before the first 100-message history page,
  with both benign and invalidating messages after it. Restart the runtime and
  confirm recovery follows every history cursor, attributes the result to A,
  and reaches the same freshness decision without trusting the latest commit
  status alone.
- Move A to another Client or runtime provider through the existing
  runtime-switch flow without changing A's UUID. Confirm the PR Chat and result
  identity remain stable, the old route loses authority, and the replacement
  runtime may recover A's own same-head result after fresh live checks rather
  than being forced into a synthetic Reviewer reassignment.
- With an App installed only for a comparison fixture, deliver a webhook for a
  managed PR and confirm no App review run or second verdict appears. Confirm a
  pre-existing unmanaged PR may still complete the read-only App path.

## Expected Result

`PASS`: evidence proves one assigned Reviewer owns the managed PR, no App is
required, repairs remain in scope and are fully re-reviewed, stale/revoked
turns fail closed, only the exact passing head is squash-merged, recovery is
idempotent per Chat + Reviewer UUID + head, Reviewer replacement does not create
a second Chat or inherit another Reviewer's result, same-Agent runtime switching
preserves identity, only a fresh matching result authorizes merge, complete
history pagination preserves the same recovery decision, and the App path does
not duplicate the managed result.

`FAIL`: an unassigned or disabled Agent acts; packet prose grants authority;
repair escapes scope; a stale head publishes or merges; another merge method,
force/bypass, or GitHub approval is used; App installation is required; or a
managed PR receives a second App verdict; B reuses A's same-head result; A
reuses B's result after ABA; Reviewer replacement creates another PR Chat; or a
same-Agent runtime switch changes Reviewer identity; a stale/unproven result
authorizes reuse or merge; recovery stops at the first history page; or a
commit status is treated as sufficient proof of result ownership.

`BLOCKED`: the isolated cell cannot provide the full product surfaces,
disposable GitHub repo, eligible runtime, task delivery, or controlled
concurrency/check conditions.

`INCONCLUSIVE`: only source/tests/logs are available, or observed GitHub, Chat,
and runtime effects cannot be tied to the candidate ref.

## Evidence

Keep target refs; redacted binding/assignment and packet summaries; Chat/Inbox
timeline; predecessor/successor and merged SHAs; repair-scope diff; check and
merge records; disabled/reassigned and race traces; the stable Chat id plus
redacted A/B Agent UUIDs and result markers; assignee-reconciliation and
runtime-switch traces; terminal-result boundary and complete-history cursors;
freshness inputs and decisions; restart recovery; and proof that the managed PR
received no App review. Never retain credentials, private sessions, hidden
prompts, or unrelated content.
