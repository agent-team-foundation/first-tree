---
id: agent-context-review-workflow
description: Validate one stable managed PR task Chat from member Write dispatch through Reviewer replacement, repair, successor review, and exact-head squash merge.
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
- Log the CLI in as a human member with a linked GitHub identity, retaining the
  standard member credentials and `client.yaml`. Keep the Client Runtime and
  daemon stopped, create no local Working Agent, and establish no active
  Computer connection for the Write/dispatch path.
- Give the Host GitHub identity only ordinary branch/PR write and merge access;
  configure a disposable check for waiting/failure cases.
- Prepare a verified same-repository managed PR with the exact marker, immutable
  repair scope, and strict `taskType = context_tree_pr_review` plus
  `reviewPacketV1` metadata file. Dispatch only through member
  `chat create --as-member`; do not use a private endpoint, caller-supplied
  Reviewer/task key/topic, or another packet shape.
- Prepare clean, repairable, protected/out-of-scope, stale-head, author-race,
  malformed-packet, and disabled/reassigned fixtures.
- Store redacted evidence outside the repository.

## Operate and Observe

- Read `first-tree --json org context-tree review-config --as-member` from that
  logged-in member state while the Client Runtime and daemon remain stopped,
  with no local Agent or active Computer connection. Then read agent-scoped
  config as the assigned Reviewer and another Agent. Confirm member selection
  fails closed when Team choice is ambiguous, only the assigned Agent reports
  `Assigned`, repository/branch are live, and no App is required.
- Dispatch through the real CLI and confirm the signed-in human authored the
  immutable opening, the configured private Reviewer became a speaker, and one
  notify=true Inbox delivery exists. Retry concurrently and with a new head;
  confirm the stable Team + task type + canonical repository + PR identity
  returns the same Chat/opening without duplicate wake or packet replacement.
- Reassign A to B and retry the same dispatch. Confirm the same Chat atomically
  backfills B, appends one server-authored takeover addressed only to B,
  removes A as Reviewer speaker, and recomputes watcher/audience state without
  changing human participants or history. Repeat the retry, disable/re-enable
  A, and exercise A → B → A; confirm no duplicate takeover/wake and no Reviewer
  inherits another Reviewer's same-head result.
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
  Chat, B's Agent UUID, and the inspected head. Confirm GitHub and Chat use the
  exact marker `<!-- first-tree-context-review-result:v1 chat=<chat-uuid> reviewer=<reviewer-uuid> head=<head-sha> -->`
  with lowercase canonical values, fixed field order, and the outcome outside
  the identity marker. Require the terminal Chat row's `senderId` to equal B's
  UUID. Have another speaker copy the marker and confirm forged or ambiguously
  ordered candidates cannot establish ownership.
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
  Also edit a message created before `READY` after the terminal result and edit
  the terminal result itself. Confirm complete-history `metadata.editedAt`
  ordering makes both results stale or freshness-unproven even when the current
  edited text appears benign. Separately edit the PR body and each GitHub
  discussion type after `READY`; confirm `updatedAt`/`lastEditedAt` crossing the
  boundary has the same fail-closed effect.
- Add a human decision after the complete review but before GitHub projection,
  and again after projection but before the terminal Chat result. Confirm the
  Reviewer runs two stable complete-history passes, incorporates the first
  decision before projection, and appends no terminal result for the second
  until it has re-reviewed and updated the projection. Confirm the Reviewer's
  own expected canonical comment/status write is accepted as the sole
  post-projection delta, while any other GitHub or Chat input change fails
  closed.
- Put A's matching terminal result before the first 100-message history page,
  with both benign and invalidating messages after it. Restart the runtime and
  force multiple messages onto the same millisecond at one page boundary, and
  confirm the real `first-tree chat history --cursor` path accepts each opaque
  cursor without shell quoting and skips or duplicates no boundary message.
  Append and edit messages while the first pass is paging; confirm the ordered
  `(id, createdAt, editedAt)` digest changes, the scan restarts, two consecutive
  passes eventually agree, and only then does recovery attribute the result to
  A without trusting the latest commit status alone.
- Move A to another Client or runtime provider through the existing
  runtime-switch flow without changing A's UUID. Confirm the PR Chat and result
  identity remain stable, the old route loses authority, and the replacement
  runtime may recover A's own same-head result after fresh live checks rather
  than being forced into a synthetic Reviewer reassignment.
- With an App installed for a comparison fixture, first create the managed task
  through the same member Write dispatch. Confirm delayed `pull_request.opened`
  appends no managed trigger, while synchronize, ready/reopen,
  PR-body/repair-scope edits, and issue/review-comment create/edit events
  append to that one task Chat and wake only the live Reviewer. Confirm delivery
  retries deduplicate through the existing webhook claim, a missing task never
  creates an App-owned task, and title/label noise appends no managed trigger.
  Confirm substantive Bot/Mannequin comments and comments with missing or
  unknown actor type remain protected review input; actor type alone never
  suppresses them.
- Force generic audience delivery to fail after the managed trigger commits,
  then retry the same GitHub delivery id after the outer claim is released.
  Confirm the task still contains one protected event and one Inbox wake. If
  the live Reviewer changed meanwhile, confirm the retry adds only the unique
  takeover wake and silently backfills the already-recorded event.
- Change A to B before one App follow-up. Confirm the event transaction performs
  silent history backfill, removes A, recomputes watcher/audience state, and
  combines the unique takeover plus GitHub trigger into one B-only active wake.
  Remove the managed marker in a PR-body edit and confirm the stable task key
  still routes that scope change and later comments to the same Chat.
- Publish A's canonical result comment. Confirm its created reflection and
  later self-edits are silent only after the immutable GitHub comment id is
  captured from A's outbound upsert and bound by the fixed local receipt suffix
  on an authoritative A terminal Chat row. Send that terminal through the real
  addressed agent endpoint using `-F`/stdin; require the hidden receipt's
  `to=@recipient` token to prevent a persisted routing prefix and allow only one
  explicit LF/CRLF file terminator after the receipt. Require the webhook
  comment id to equal that receipt and the current GitHub body to equal the
  terminal content before the receipt byte for byte. Confirm the same
  author/id/marker with a
  human-edited meaningful body, an unknown or copied comment id, copied marker,
  different author/Reviewer/head, removed marker, malformed or edited receipt,
  legacy receipt absence, ambiguity, or pre-terminal reflection is preserved as
  new input. Confirm the App creates no review run, GitHub approval, merge, or
  second verdict. A pre-existing unmanaged PR may still complete the legacy
  read-only App path.
- Explicitly follow the same PR from another collaboration Chat and repeat a
  meaningful event. Confirm the managed task receives its protected trigger
  while the followed Chat still receives its ordinary GitHub card. This is not
  a second managed task or verdict; generic entity binding remains an
  independent, decision-locked delivery surface.
- Revoke the managed task requester's membership, then deliver another event
  for a separately followed Chat. Confirm the managed task remains unchanged
  and reports fail-closed unavailability, while the ordinary followed Chat
  receives exactly one GitHub card. Replay the same delivery id and confirm
  neither surface duplicates work. Unexpected/transient managed failures still
  release the whole delivery claim for GitHub retry.

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
authorizes reuse or merge; a terminal marker whose Chat `senderId` is not the
current Reviewer establishes ownership; an unstable history scan is accepted;
recovery stops at the first history page; or a commit status is treated as
sufficient proof of result ownership.

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
freshness inputs, stable-scan digests, Chat `createdAt`/`metadata.editedAt`,
GitHub edit timestamps, terminal sender ownership, and decisions; restart
recovery; and proof that the managed PR received no App review. Never retain
credentials, private sessions, hidden prompts, or unrelated content.
