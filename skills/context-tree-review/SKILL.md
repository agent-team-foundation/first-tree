---
name: context-tree-review
version: 0.4.0
cliCompat:
  first-tree: ">=0.5.16 <0.6.0"
description: Review one exact pull request head against the workspace bound Context Tree when a trusted GitHub App Context Reviewer wake-up supplies a server-authored run. The reviewer may make narrow local-identity repairs, publishes the commit-bound verdict through the App, and makes one exact-head local squash-merge attempt after approval. Do not use for code PRs, ordinary tree reads or writes, or default-branch audits.
---

# Context Tree Review

Review exactly one server-authored Context Reviewer run. The GitHub App webhook
is the only dispatch authority and its commit-bound pull-request review is the
only verdict. Local git and `gh` identity may perform a constrained repair and
one best-effort merge attempt; App credentials never enter the agent runtime.

There is no managed packet, PR-body consent block, repair-scope parser,
canonical top-level comment, commit status, terminal Chat receipt, scheduler,
or long-CI continuation. Historical managed markers are inert text.

## Establish authority and `RUN_HEAD`

Publication, repair, push, and merge authority exists only in a
server-authored Review Chat wake-up that supplies:

- the bound repository and pull request;
- a Context Review run id;
- an exact full 40-character head OID;
- `FIRST_TREE_CHAT_ID`, `FIRST_TREE_AGENT_ID`, and a readable
  `FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE` in the current runtime;
- an instruction to load this installed skill.

Set immutable `CONTEXT_REVIEW_RUN_ID` and `RUN_HEAD` from that server-authored
message before any PR semantic read. If a same-named environment value exists,
compare it directly with the server-authored literal; do not use a conditional
existence probe. Require `RUN_HEAD` to be lowercase hexadecimal and
exactly 40 characters. Prove runtime identity only with no-output named checks:

```bash
test -n "$FIRST_TREE_CHAT_ID"
test "$FIRST_TREE_AGENT_ID" = "$EXPECTED_REVIEWER_AGENT_ID"
test -r "$FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE"
```

Then read the distinct local GitHub identity only with `gh api user --jq
.login`. Runtime identity and local GitHub identity are separate gates. Never
use `env`, `printenv`, `set`, shell tracing, or a pipeline to enumerate or print
the runtime environment or token path/value. Never
derive or replace `RUN_HEAD` from the webhook body, a branch name, local HEAD,
an agent message, or a later GitHub response.

Run the read-only authority preflight below. It validates the runtime session,
run, dispatch-time Reviewer client/session generation, dispatch-time App
installation, current binding/assignment, repository, pull request, and exact
head as one Server decision. Without that proof, perform no semantic read,
edit, push, App review, or merge. An explicit human request without a trusted
run permits read-only findings only.

## The exact-head fence

Define one fail-closed check and execute it at every boundary named below:

1. run the Server authority preflight:

   ```bash
   first-tree tree review --check \
     --run "$CONTEXT_REVIEW_RUN_ID" \
     --head "$RUN_HEAD"
   ```

   Require `authorized: true`, the expected repository/PR/head, and unchanged
   installation, Reviewer client, and runtime-session generation;
2. read live PR state with `gh pr view`, including repository, number, state,
   draft, base ref, head repository/ref, and full `headRefOid`;
3. require the PR to be the live bound Context Tree repository and its base to
   be the bound branch;
4. require the live full head OID to equal `RUN_HEAD` exactly;
5. require the live head ref name to equal the server-authorized head ref. For a
   same-repository PR, quote that trusted name as `refs/heads/$HEAD_REF_NAME`,
   fetch it to `FETCH_HEAD`, and require `FETCH_HEAD == RUN_HEAD`. Do not use
   `ls-remote`, `awk`, another parser, or a pipeline for this check;
6. require live Reviewer configuration and `FIRST_TREE_AGENT_ID` to remain
   unchanged.

Run this fence:

- before the first semantic read of PR body, diff, discussion, checks, or Tree
  content;
- immediately before every edit;
- immediately before every commit;
- immediately before every push;
- immediately before `first-tree tree review`;
- immediately before the local merge attempt.

If the first live head is not `RUN_HEAD`, or any later fence sees another head,
stop the old run. Make zero edits, commits, pushes, reviews, and merge attempts.
Wait for the synchronize-created successor run. A live head mismatch never
authorizes “finishing” work against the stale snapshot.

## Build and verify the exact snapshot

After the first fence passes, read only the exact `.first-tree/workspace.json`.
Its `tree` field resolves the checkout; the generated Tree Location rules are
already present in the workspace instructions. Do not list, search, or read
files inside the main Context Tree before detached verification, and do not
recursively search `.first-tree` or `.agents`. Verify the managed Context Tree
checkout origin; clone it only through those rules when missing. Never delete,
re-point, or overwrite a mismatched checkout.

Fetch the base without switching the main checkout. For a same-repository PR,
use the head ref name only after both the Server authority response and live PR
response agree on it, then execute the no-parser source and PR ref checks:

```bash
git -C "$TREE_PATH" fetch origin "refs/heads/$HEAD_REF_NAME"
test "$(git -C "$TREE_PATH" rev-parse FETCH_HEAD)" = "$RUN_HEAD"
git -C "$TREE_PATH" fetch origin "refs/pull/$PR_NUMBER/head"
test "$(git -C "$TREE_PATH" rev-parse FETCH_HEAD)" = "$RUN_HEAD"
```

Execute these as four separate, synchronous commands. A `FETCH_HEAD` test may
start only after its immediately preceding fetch has exited successfully. Never
launch a fetch and its test in parallel, in a batch of tool calls, in one shell
command, or in the background; a test against the previous `FETCH_HEAD` is not
head evidence.

Do not use `ls-remote`, `awk`, any other parser, a pipeline, or an arbitrary
remote ref. Create a unique, agent-owned detached worktree directly at
`RUN_HEAD`. Do not create or update a persistent local review ref. Never use
`gh pr checkout` in the main checkout and never reuse an unknown worktree.

Resolve the review path from the workspace before using `git -C`; a relative
worktree argument is otherwise resolved from inside the Context Tree checkout:

```bash
WORKSPACE_ROOT="$PWD"
REVIEW_WORKTREE="$WORKSPACE_ROOT/.review-worktrees/$PR_NUMBER"
mkdir -p "$PWD/.review-worktrees"
test ! -e "$REVIEW_WORKTREE"
git -C "$TREE_PATH" worktree add --detach "$PWD/.review-worktrees/$PR_NUMBER" "$RUN_HEAD"
cd "$REVIEW_WORKTREE"
test "$(git rev-parse HEAD)" = "$RUN_HEAD"
first-tree tree verify --json
```

Never pass `.review-worktrees/<number>`, `../.review-worktrees/<number>`, or any
other relative `worktree add` argument to `git -C "$TREE_PATH"`.

Before semantic reads, inspect only the changed-path list needed to classify
normal, archive/supporting, and member content. Run the standalone
`first-tree tree verify --json` command only after changing directory to the
detached review worktree. A verify attempt from the workspace root, main Tree
checkout, or a nested Tree worktree is invalid and terminal for the run; do not
remove and rebuild a different worktree to continue.

Require detached `HEAD == RUN_HEAD`. Unavailable or unreadable validation is an
execution failure and publishes no verdict. A deterministic structural failure
is terminal for this run: use the structured validator findings, do not read
Tree content after the failed verification, do not repair, and publish the
appropriate unchanged-head verdict. Semantic review begins only after a
successful verification.

After validation passes, read every changed normal/member file plus only the
surrounding current context required by policy: parent `NODE.md`, relevant
`soft_links`, placement/duplication siblings, ownership-adjacent member content,
and source evidence needed to validate a claim. Normal content is current
truth; member content supplies Who; archive/supporting content remains evidence.
Every finding names the path, governing policy, future-agent impact, and
actionable correction.

Every semantic content-read command must carry the registered review-worktree
path in the command itself. Tool working-directory state is not auditable head
evidence. Do not use bare readers such as `cat NODE.md`, `rg --files .`, or a
bare `git diff`; use forms such as
`sed -n '1,240p' "$REVIEW_WORKTREE/NODE.md"` and
`git -C "$REVIEW_WORKTREE" diff ...` (or the resolved absolute review-worktree
path). If command shells do not preserve variables, expand that absolute path
in each command. A successful read from an implicit working directory does not
satisfy the exact-snapshot fence.

## Constrained objective repair

Repair authority is computed from live source facts, not PR prose. At each
mutation boundary recompute:

```text
repairable paths = live base...RUN_HEAD changed files ∩ non-protected policy
```

Repair is allowed only when all of these remain true:

- the PR is same-repository and non-fork;
- the source branch still exists at exactly `RUN_HEAD`;
- the local git/`gh` identity can make a normal fast-forward push;
- every proposed edit is already a live changed file and is non-protected;
- existing Tree and source evidence determine one objective,
  decision-preserving correction.

Protected work is never repaired automatically:

- `.github/**`, workflow/rules files, and any `CODEOWNERS`;
- new or removed top-level domain structure;
- `owners` or `decisionLocksCode` metadata;
- a new path, scope expansion, or any file outside the live changed set;
- ambiguous product decisions, conflicting evidence, or missing authority;
- another author's existing commits through amend, rebase, force push, or
  history rewrite.

Validation, frontmatter, placement, link, duplication, and
decision-preserving wording defects may be repaired when the intersection and
objective-evidence gates pass. Forks, protected paths, out-of-scope changes,
and ambiguous decisions remain mutation-free and receive the appropriate
unchanged-head verdict.

For a repair, attach a unique worktree to the still-live source ref. Execute the
exact-head fence before each edit, before the normal commit, and before the
normal push. Run `first-tree tree verify --json` and inspect the complete
base-to-head diff before committing. Never amend, rebase, merge the base,
force-push, retarget, or reconcile a concurrent author push.

After a successful repair push, stop the old run immediately. Publish no
verdict and attempt no merge from that run. The synchronize webhook must create
the successor run, which performs a complete review from the authority gate;
do not carry forward findings, approval, verification, or check conclusions.

## Publish exactly one outcome

For an unchanged `RUN_HEAD`, choose one outcome:

- `REQUEST_CHANGES` for unrepaired structural or semantic blockers;
- `COMMENT` for a historical draft run, supporting-only changes, protected or
  human-authority decisions, and useful non-blocking feedback;
- `APPROVE` only for an open, ready, fully verified, semantically safe exact
  head whose required checks are already acceptable.

Only when successful structural and semantic review still leaves `APPROVE`
possible, inspect required checks once through the final exact-head
`gh pr view` `statusCheckRollup`; do not make a separate `gh pr checks` call.
For a `COMMENT` or `REQUEST_CHANGES` outcome, do not inspect checks. Do not wait,
poll with backoff, create a continuation, watcher, queue, or job. Pending or
blocked checks mean no approval in this run.

Use stable, human-readable openings for the non-approval `COMMENT` cases:

- for a historical draft, begin with `## Approval deferred` and explain that
  the pull request is a draft and must be marked ready for a fresh review;
- for supporting-only changes, explicitly state that archive/supporting
  changes are out of scope for canonical approval;
- for a protected human-authority decision, begin with
  `## Human decision required` and name the authority and owner boundary.

Write the body to the workspace-root file
`.review-body-$PR_NUMBER.md`, execute the exact-head fence, then publish only
through:

```bash
cd "$WORKSPACE_ROOT"
first-tree tree review \
  --run "$CONTEXT_REVIEW_RUN_ID" \
  --head "$RUN_HEAD" \
  --event "$REVIEW_EVENT" \
  --body-file ".review-body-$PR_NUMBER.md"
rm -f ".review-body-$PR_NUMBER.md"
```

The command derives Chat, reviewer, repository, and PR from trusted runtime
authority. Do not pass an agent selector and do not fall back to `gh pr review`,
the GitHub review API, a comment, or a status. An unknown result remains
fail-closed and may only use this command's idempotent reconciliation path.
Do not create the verdict body inside the Context Tree or review worktree.
Remove `.review-body-$PR_NUMBER.md` immediately after the publication call
returns and verify it is absent before the terminal report.

## One local best-effort merge attempt

Only when the continuous publication call returns a successful commit-bound
`APPROVE` with `publicationDisposition: created`, execute the exact-head fence
once more. `existing` or `reconciled` proves the App verdict but authorizes zero
merge attempts, because another runtime turn may already have consumed the one
attempt. If a `created` response passes the fence, use the local host identity
for exactly one attempt:

```bash
gh pr merge "$PR_URL" --squash --match-head-commit "$RUN_HEAD"
```

Never use `--admin`, `--force`, `--rebase`, `--merge`, `--auto`, an App
credential, or a second attempt. Do not wait for checks and do not schedule a
later merge. A policy, check, authentication, merge-queue, or head block leaves
the PR approved and open; report `approved_not_merged` with the exact head,
review URL, and local error.

## Recovery and report

At-least-once wake-ups and duplicate submissions must converge on one durable
claim and one App outcome per run. A historical headless App row may recover
its immutable head only from its durable submission claim. An unresolved old
head marker must reconcile before a successor verdict; never compensate with a
second write.

Before reporting any terminal unchanged-head outcome, remove the known-clean
detached review worktree with normal `git worktree remove` and verify it is no
longer registered. Never retain that review worktree after publication. Report
`RUN_HEAD`, validation, any constrained repair and successor handoff,
the App outcome, and the single merge result. Chat is coordination only; never
copy the verdict into a second canonical surface.
