---
id: agent-context-review-workflow
description: Validate GitHub App exact-head Context Review through repair, successor review, approval, and local squash merge.
areas: [cross-surface]
surfaces: [cli, client, server, github, runtime]
---

# GitHub App Context Review Workflow

## Goal

Confirm that every supported event for a ready pull request in the bound Context
Tree repository reaches one PR-scoped Reviewer Chat and one trusted run for the
current head. Confirm the Reviewer may repair only the declared scope with its
local GitHub identity, while only the GitHub App publishes commit-bound reviews
and only the local identity performs an exact-head squash merge.

Deterministic schema, route, and Skill wording checks belong in product tests
and Skill evals. This case proves the assembled App webhook, Chat/Inbox, agent
runtime, CLI, GitHub review, repository gate, concurrency, and recovery behavior.

## Preconditions

- Use an isolated candidate deployment, temporary worktree, disposable GitHub
  organization/repository, and a real installation of the candidate GitHub App.
- Bind the disposable repository as the Team Context Tree, enable Context
  Reviewer, and assign an active non-human Reviewer Agent. Ensure the live
  installation has accepted pull_requests: write; leave all other App
  permissions and webhook subscriptions at their current product settings.
- Give the Reviewer's host GitHub identity ordinary same-repository branch push
  and merge access. Do not expose an installation token to the runtime.
- Configure the default-branch ruleset to require pull requests, at least one
  current approval, stale-review dismissal on push, and non-fast-forward
  protection. Disable Code Owner and last-push approval requirements. Do not
  configure the App as a bypass actor.
- Prepare ready, draft, fork, clean, validator-failing, semantic-failing,
  repairable, protected/out-of-scope, stale-head, race, check-failing, and
  merge-failing fixtures. Each authoring PR body must declare source,
  decision/rationale, verification result, and exactly one fixed
  `## Context Tree Review` consent block whose sorted, deduplicated
  `### Repair scope` contains only Markdown code-span exact file paths.
- Store redacted evidence outside the repository.

## Operate and Observe

- Open a ready bound Context Tree PR. Confirm the App webhook creates one
  PR-scoped Reviewer Chat, adds the configured Reviewer, and sends one trusted
  run message containing Server-authored repository, PR, head, and run identity.
  Confirm no writer-created review Chat or caller-authored task packet exists.
- Replay the delivery and send opened, reopened, ready_for_review, and
  synchronize events for the same PR/head. Confirm delivery idempotency and
  one stable Chat. Send issue and review comments and confirm substantive
  discussion reaches the same Chat while unsupported title/label noise does
  not create another review run. Confirm `pull_request.edited` creates a run
  only when `changes.body` is present; reject other metadata edits and
  `issue_comment.edited`, while retaining `pull_request_review_comment.edited`.
- Create a historical PR containing the retired dispatch marker. Confirm it
  follows the same App path and receives no special suppression or routing.
- Reassign or disable the Reviewer before a new event and before submission.
  Confirm the current assignment is resolved live, the stale runtime loses
  authority, and no previous Reviewer's result authorizes the replacement.
- Confirm the run message is trusted only when its Server-authored metadata and
  runtime routing identity validate. Reproduce missing, malformed, copied, and
  caller-authored metadata and confirm the Skill refuses to review or mutate.
- For every run, confirm the Reviewer resolves the bound repository and PR,
  fetches the exact head, verifies the live head and base, creates a detached
  snapshot, and runs Context Tree validation before semantic review. Draft,
  fork, stale run, changed head, binding mismatch, and missing permissions fail
  closed without mutation or verdict.
- Exercise validation and semantic failures. Confirm the Reviewer uses
  first-tree tree review with the trusted run id and exact head to publish
  REQUEST_CHANGES or COMMENT; the removed GitHub command is unavailable.
- Exercise a safe repair in a same-repository branch. Confirm local git and gh
  credentials create and push only objective, decision-preserving changes
  inside the declared changed-tree scope. Confirm owners, protected structure,
  decision locks, CODEOWNERS, workflow files, and ambiguous decisions are never
  modified automatically.
- Exercise missing, duplicate, malformed, unsorted, repeated, glob, directory,
  absolute, traversal, protected-path and extra-entry Repair scope bodies.
  Confirm each disables mutation but still permits an appropriate read-only
  exact-head verdict. Change the live body or changed-path set before every
  edit/commit/push/publication/merge boundary and confirm the old run stops.
- After repair push, confirm the predecessor run publishes no verdict and stops.
  The synchronize webhook must create a successor run for the new exact head;
  the Reviewer repeats validation and complete semantic review from the
  beginning. Confirm no previous-head finding or approval is reused.
- Race an author push against review, submission, repair push, checks, and merge.
  Confirm exact-head checks prevent a stale run from publishing or merging and
  no force push is attempted.
- For a clean current head, wait for required checks and invoke first-tree tree
  review with run, head, APPROVE, and body-file arguments. Confirm the Server
  re-resolves the live installation, binding, PR, run, Reviewer, and head,
  fails closed without live pull_requests: write, and creates exactly one
  GitHub App review whose commit id is the inspected head.
- Confirm the App approval satisfies the repository's generic one-approval gate.
  Push a new commit and verify GitHub dismisses the stale approval so the old
  review no longer satisfies the gate.
- After approval, confirm the Reviewer uses its local identity to invoke only
  gh pr merge --squash --match-head-commit SHA. Reject --admin, --auto, force
  push, App-token merge, and alternate merge methods.
- Force local merge permission, ruleset, check, and transient provider failures.
  Confirm the durable outcome is approved, not merged; the App approval is not
  rolled back, no duplicate review is published, and a retry occurs only after
  the same live head and checks are revalidated.
- Restart the runtime after delivery, after repair, after approval, and before
  merge. Confirm recovery comes from the stable PR Chat, trusted run, live PR
  state, and exact head without duplicate Chat, verdict, or merge.
- Follow the same PR from another collaboration Chat. Confirm that Chat still
  receives ordinary GitHub cards while Context Reviewer dispatch remains one
  independent PR-scoped App path.

## Expected Result

PASS: evidence proves a single App-managed PR Chat/run path; exact-head,
idempotent App reviews; local-scope repair followed by complete successor-head
review; generic current approval plus stale dismissal; and local exact-head
squash merge without bypass.

FAIL: a writer or caller can create review authority; a task packet or legacy
marker changes routing; a stale/fork/draft run mutates, publishes, or merges;
a repair escapes scope; repair and approval occur in one predecessor run; the
App merges; the local identity publishes a review; an old approval survives a
push; or any bypass/force/alternate merge path is used.

BLOCKED: the isolated cell cannot provide the full candidate surfaces, a
disposable GitHub repository, a real accepted App installation, eligible
runtime, repository ruleset, or controlled check/concurrency conditions.

INCONCLUSIVE: only source/tests/logs are available, or the observed App review,
Chat/run identity, repaired heads, approval dismissal, and local merge cannot
be tied to the candidate ref.

## Evidence

Keep target refs; redacted installation permission and binding/assignment
summaries; webhook delivery ids; stable Chat/run ids; predecessor/successor and
reviewed/merged SHAs; validation output; repair-scope diff; GitHub App review
actor/event/commit id; ruleset and stale-dismissal observations; check and merge
records; permission/race/restart traces; and proof that neither duplicate
dispatch nor bypass occurred. Never retain credentials, installation tokens,
private sessions, hidden prompts, or unrelated content.
