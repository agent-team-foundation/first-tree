---
id: agent-context-review-workflow
description: Validate GitHub App Context Review through local repair, App review publication, repository approval gate, and local squash merge.
areas: [cross-surface]
surfaces: [cli, client, server, github, runtime]
---

# GitHub App Context Review Workflow

## Goal

Confirm that supported activity on a pull request in the bound Context Tree
repository creates or reuses one PR-scoped Reviewer Chat and wakes the assigned
review agent. Confirm the agent reviews the latest live PR, may repair it with
its local identity, publishes the formal verdict through the GitHub App, and
uses its local identity for squash merge.

Deterministic schemas and Skill wording belong in product tests and Skill
evals. This case proves the assembled App webhook, Chat/Inbox, runtime, CLI,
GitHub review and repository gate.

## Preconditions

- Use an isolated candidate deployment and disposable GitHub organization and
  repository with a real installation of the candidate GitHub App.
- Bind the repository as the Team Context Tree, enable Context Reviewer, and
  assign an active non-human Reviewer Agent. Ensure the installation has
  accepted `pull_requests: write`; keep all other App permissions and webhook
  subscriptions at current product settings.
- Give the Reviewer's host GitHub identity ordinary same-repository branch push
  and merge access. Do not expose an installation token to the runtime.
- Configure the default-branch ruleset to require pull requests, at least one
  current approval, stale-review dismissal on push, and non-fast-forward
  protection. Disable Code Owner and last-push approval requirements. Do not
  configure the App as a bypass actor. For a migrated repository, confirm no
  effective ruleset still requires the retired `first-tree/context-review`
  status, which the App-review-only workflow no longer publishes.
- Prepare ready, draft, fork, validator-failing, semantic-failing, repairable,
  check-failing and merge-failing PRs. The PR body needs no repair-consent or
  machine-readable scope block.
- Store redacted evidence outside the repository.

## Operate and Observe

- Open a ready bound Context Tree PR. Confirm the App webhook creates one
  PR-scoped Reviewer Chat, adds the configured Reviewer, and sends a trusted
  run message containing Server-authored repository, PR and run identity.
  Confirm no writer-created review Chat or task packet exists.
- Replay the same delivery and send opened, reopened, ready-for-review and
  synchronize events. Confirm webhook delivery-id deduplication and one stable
  Chat. Separate supported events may create separate run messages; occasional
  duplicate wake-ups are acceptable. Confirm PR metadata edits and edited issue
  comments do not trigger Context Review, while created issue comments and
  created/edited review comments do.
- Confirm ordinary GitHub follow, mention and review-request Chat behavior is
  unchanged and independent of the Reviewer Chat.
- Reassign or disable the Reviewer before submission. Confirm the caller loses
  authority and no App review is published.
- Confirm the Reviewer resolves the bound repository and latest live PR,
  creates an isolated worktree, and runs `first-tree tree verify --json` before
  semantic review. Draft and fork PRs remain non-approving/read-only.
- Exercise validation and semantic failures. Confirm the Reviewer uses
  `first-tree tree review --run ... --event REQUEST_CHANGES|COMMENT --body-file ...`;
  the removed GitHub command, `--head`, and `--agent` are unavailable.
- Exercise a domain `NODE.md`, changed `soft_links`/Markdown link or explicit
  cross-domain reference, and node add/move/rename/delete change. Confirm the
  Reviewer expands only to affected outgoing targets, incoming references,
  direct children, mechanically dependent deeper descendants/neighbours and
  ownership context. A leaf-local body change with none of those observable
  triggers is `N/A` and does not become a whole-tree audit. Confirm an otherwise
  ready PR with only `Advisory` findings is approved with the advice in the
  approval body. A proven authority violation requests changes; a case whose
  authorized choice cannot yet be established comments with a human-decision
  request.
- Exercise a repair on a same-repository branch. Confirm local git/`gh`
  credentials create and push decision-preserving changes, never force-push,
  amend, rebase, edit protected ownership/decision-lock material without clear
  authority, or use an App token. After push, confirm the agent fetches and
  fully checks the latest resulting PR state. On that successor head, confirm it
  reruns validation, the complete Evidence pass, the complete Challenge pass and
  required checks instead of reusing predecessor reads or conclusions. Confirm
  the original blocker is gone and the repair introduced no new blocker before
  approval. A synchronize-triggered duplicate run is acceptable.
- For a clean ready PR, wait for required checks and invoke `tree review` with
  run, `APPROVE`, and body-file arguments. Confirm the Server re-resolves the
  live installation, binding, PR, configured Reviewer and current head, then
  creates exactly one App review for that head. Confirm missing or revoked
  `pull_requests: write` fails closed.
- Simulate an uncertain GitHub review write. Confirm the existing
  pending/submitting/unknown/failed/submitted publication state and hidden run
  marker reconcile the same run without a duplicate POST.
- Confirm the App approval satisfies the generic one-approval gate. Push a new
  commit and verify GitHub dismisses the stale approval, so the old approval no
  longer satisfies the gate.
- After approval, confirm the Reviewer uses only local
  `gh pr merge <number> --repo <repo> --squash`. Reject `--admin`, `--auto`,
  force push, App-token merge and alternate merge methods.
- Force local merge permission, ruleset, check and transient provider failures.
  Confirm the agent reports approval plus the merge error, does not duplicate
  or roll back the App review, and does not claim success.

## Expected Result

PASS: the App webhook owns review dispatch; the Reviewer can repair with its
local identity; the App alone publishes the PR review; the repository requires
a current approval and dismisses it after push; and local squash merge does not
bypass the gate.

FAIL: a writer can create review authority; a task packet or legacy marker
changes routing; a fork/draft run mutates or approves; the App merges; the local
identity publishes the review; an old approval survives a push; or a bypass,
force push, `--admin`, or `--auto` path is used.

BLOCKED: the isolated cell cannot provide the candidate surfaces, disposable
GitHub repository, real accepted App installation, eligible runtime or
repository ruleset.

INCONCLUSIVE: only source/tests/logs are available, or the observed App review,
repair, stale-approval dismissal and local merge cannot be tied to the
candidate ref.

## Evidence

Keep target refs; redacted permission and binding/assignment summaries;
webhook delivery ids; stable Chat and run ids; validation output; repair diff;
GitHub App review actor/event/commit id; ruleset and stale-dismissal evidence;
check and merge records; and proof that no removed dispatch or bypass path was
used. Never retain credentials, installation tokens, private sessions, hidden
prompts or unrelated content.
