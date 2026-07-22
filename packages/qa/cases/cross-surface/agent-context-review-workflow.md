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
review agent. Confirm the agent reviews the latest live PR, repairs every safely
determined finding with its local identity before escalation, publishes the
formal verdict through the GitHub App, and uses its local identity for squash
merge.

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
- Prepare ready, draft, fork, repairable validator-failing, repairable
  semantic-failing, mixed safe/protected, push-denied, check-failing and
  merge-failing PRs. The PR body needs no repair-consent or machine-readable
  scope block.
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
- Exercise repairable validator and semantic failures on a same-repository
  branch. Confirm local git/`gh` credentials repair, commit, and push every
  objectively determined, decision-preserving finding before the agent chooses
  an App outcome. Immediately before mutation, confirm the live PR and source
  branch still equal the reviewed head. Confirm the exact repair paths,
  including additions, moves and deletions, are staged before repair
  validation; then confirm status and the complete cached base-to-result diff
  are inspected with no later content/index mutation before the normal commit
  and push. A fully repairable ready PR must not ask the author to change it and
  must approve only after validating and semantically reviewing the successor
  head.
- Exercise mixed safe and protected findings. Confirm the Reviewer repairs the
  safe batch first, then uses
  `first-tree tree review --run ... --event COMMENT --body-file ...` to hand off
  only the residual ownership, decision-lock, governance, or ambiguous product
  decision. Confirm the removed GitHub command, `--head`, and `--agent` remain
  unavailable.
- Deny a normal source-branch push. Confirm the Reviewer does not force-push,
  amend, rebase, alter remotes, or use an App token; it reconciles observable
  refs and submits `REQUEST_CHANGES` with the specific push blocker and one
  recovery action. After every successful repair push, confirm the agent
  fetches, validates, and fully reviews the latest resulting PR state. A
  synchronize-triggered duplicate run is acceptable.
- For a clean ready PR, wait for required checks and invoke `tree review` with
  run, `APPROVE`, and body-file arguments. Confirm the Server re-resolves the
  live installation, binding, PR, configured Reviewer and current head, then
  creates exactly one App review for that head. Confirm missing or revoked
  `pull_requests: write` fails closed. Confirm the final PR freshness read
  happens after validation, the complete semantic/content review and
  current-head checks.
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
- Confirm every known clean Reviewer-owned detached review worktree and
  branch-attached repair worktree is removed normally. Dirty or unknown paths
  must remain fail-closed for manual recovery.

## Expected Result

PASS: the App webhook owns review dispatch; the Reviewer repairs every safely
determined finding with its local identity before escalating only residual
protected or blocked findings; the App alone publishes the PR review; the
repository requires a current approval and dismisses it after push; and local
squash merge does not bypass the gate.

FAIL: a writer can create review authority; a task packet or legacy marker
changes routing; a fork/draft run mutates or approves; a safely repairable
finding goes directly to `REQUEST_CHANGES`; a mixed review returns its safe and
protected findings together to the author; a repair push is not followed by a
complete successor-head review; the App merges; the local identity publishes
the review; an old approval survives a push; or a bypass, force push, `--admin`,
or `--auto` path is used.

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
