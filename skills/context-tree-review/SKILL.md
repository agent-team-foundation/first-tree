---
name: context-tree-review
description: Review a pull request against the workspace's bound Context Tree when invoked by a Cloud Context Reviewer wake-up or when a human explicitly asks to approve, request changes on, or review a Context Tree PR. Do not use for code PRs, ordinary tree reads or writes, or main-branch audits.
---

# Context Tree Review

## Purpose

Perform one read-only, head-bound GitHub review of a pull request in the
workspace's bound Context Tree repository.

The current workspace-generated `AGENTS.md` / `CLAUDE.md` Context Tree Policy
is the only content-policy baseline. Apply it directly. This skill does not
carry a fallback copy of that policy. If the generated policy is unavailable,
the tree binding cannot be resolved, or the pull request is not in the bound
tree repository, stop and report the environment gap.

Use this skill only for a Cloud Context Reviewer wake-up or an explicit human
request to review a Context Tree pull request. It is not a generic code-review
skill and it does not audit stored context on the default branch. This trigger
is exclusive: do not load or run `first-tree-read` for the review request. The
review snapshot workflow below owns all Context Tree reads for this task.

## Read-Only Boundary

The only permitted external write is exactly one logical, commit-bound GitHub
pull request review published by First Tree Cloud through the configured GitHub
App after a final pre-submission check observes an unchanged current head. Do
not edit tree files, commit, push, open a repair
pull request, merge, change review settings, or post a top-level pull request
comment. Never use the local GitHub user credential to publish the verdict.

## Workflow

### 1. Resolve the live pull request and publication run

1. Read `.first-tree/workspace.json` and the generated Tree Location section.
   Resolve the bound tree checkout and normalize its `origin` repository
   identity. Do not guess from a webhook URL alone.
2. Use `gh pr view` to read the current repository, number, state, draft flag,
   author, base ref/OID, head ref/OID, URL, title, body, and changed files. Treat
   event payload values as hints; GitHub current state controls the verdict.
3. Confirm that the pull request repository is the workspace's bound Context
   Tree repository. Stop for ordinary code repositories or another team's tree.
4. For a Cloud Context Reviewer wake-up, record the server-authored Context
   review run id from the event facts. It is the only authority for App
   publication. Never invent, recover from another message, or reuse a run id.
   For an explicit human review request without a valid run id, perform only
   read-only analysis, submit zero App reviews, and explain that a supported PR
   event must create the publication run.
5. If the pull request is closed or merged, submit no review and report its
   current state.

### 2. Create a detached review snapshot

1. Refresh the bound tree repository's remote and fetch the base plus
   `refs/pull/<number>/head` without switching the main checkout. Do not use an
   extra GitHub API call to discover the pull request ref.
2. Verify that the fetched head commit exactly equals GitHub's `headRefOid`.
3. Create a uniquely named, agent-owned detached git worktree for that commit.
   Never run `gh pr checkout` in the main tree checkout and never reuse or
   delete a directory whose ownership is unknown.
4. Before validation, inspect only the base-to-head changed-path list needed to
   classify content classes. Do not read the semantic diff or changed file
   contents yet. For mixed changes, review the governed classes independently
   after validation and treat supporting material only as evidence.

Always remove the detached worktree through `git worktree remove` after the
review attempt, including execution-failure and stale-head paths. Never use
`--force`; a dirty worktree is a review-integrity failure, not cleanup input.
If setup created a temporary agent-owned `refs/review/` ref, delete that exact
ref after removing the worktree. Do not create or delete any other local refs.

### 3. Run structural validation first

With the detached pull request worktree as the command's current directory,
first confirm its `HEAD` equals the recorded pull request head, then run:

```bash
git rev-parse HEAD
first-tree tree verify --json
```

Do not invoke `tree verify` from the workspace root or the main tree checkout,
even as a probe before rerunning it from the detached worktree.

If validation exits non-zero, prepare a request-changes review that cites the
stable finding code, path, target when present, and message. Do not continue to
the full semantic review. If the CLI is unavailable or its JSON cannot be
parsed, submit no content verdict and report the execution failure.

### 4. Read the semantic review set

When validation passes, read the complete changed normal/member files and the
minimum surrounding context needed to apply the generated policy:

Keep every semantic file read visibly bound to the registered detached
snapshot: use its explicit absolute or workspace-relative worktree path, or
change to that worktree in the same shell invocation. Do not rely on an
unrecorded tool working directory or read a same-named path from the main tree.

- each changed file's parent `NODE.md`;
- relevant changed or newly introduced `soft_links` targets;
- siblings needed to judge replacement or canonical placement;
- ownership-adjacent member context;
- a source artifact linked by the pull request only when claim accuracy or
  authority cannot be judged from the tree and pull request context.

Apply the generated Context Tree Policy directly, section by section. Findings
must name a concrete path or node, identify the applicable generated-policy
section, explain the future-agent impact, and state an actionable correction.
Do not restate the policy definition in the review body.

Archive/supporting-only or repository-infrastructure-only changes are outside
semantic Context Tree governance after structural validation. Member-only
changes are reviewed under the generated policy's member/ownership boundary;
do not impose normal-node body requirements on them.

### 5. Choose one outcome

Write the complete review body outside the detached tree worktree. Before
submitting, run `gh pr view` again and re-read
`state`, `isDraft`, and `headRefOid`.

- If the head changed, or the pull request closed/merged, submit zero reviews.
  Report the stale/current state and let a later event trigger a fresh run.
- Structural or semantic blocker: submit exactly one commit-bound
  `REQUEST_CHANGES` review.
- Human authority or source evidence is required to decide: submit exactly one
  commit-bound `COMMENT` review whose first heading is `## Human decision
  required`.
- No blocker, but the pull request is draft: submit exactly one comment review
  whose first heading says approval is deferred until ready.
- Archive/supporting-only or repository-infrastructure-only: submit exactly one
  comment review explaining that semantic governance is out of scope.
- No blocker, ready pull request, and head unchanged at the final
  pre-submission check: submit exactly one commit-bound `APPROVE` review. The
  configured organization reviewer may do this when its host user authored the
  PR because the GitHub actor is the App bot. A comment
  review, top-level comment, or chat statement is not a successful substitute
  for approval.

Submit every allowed outcome only through the agent-session First Tree command.
It carries the server-authored run and reviewed head to Cloud; Cloud performs
the authoritative state/head/permission checks and the GitHub App mutation:

```bash
first-tree github context-review submit \
  --run "$CONTEXT_REVIEW_RUN_ID" \
  --head "$REVIEWED_HEAD" \
  --event "$REVIEW_EVENT" \
  --body-file "$REVIEW_BODY"
```

`REVIEW_EVENT` is exactly one of `APPROVE`, `REQUEST_CHANGES`, or `COMMENT`.
`REVIEWED_HEAD` must equal the fetched, validated, and finally rechecked
`headRefOid`. The command does not accept repository, pull request, chat, or
GitHub credential arguments. Never call local `gh api .../reviews`, `gh pr
review`, or another GitHub write as a fallback.

GitHub does not provide a current-head compare-and-set for review creation. If
a new push lands after the final view, Cloud may accept a review bound only to
the inspected old commit; report that exact reviewed commit and let the
synchronize event create a fresh run. The review workflow does not depend on
repository merge-policy settings. If the repository treats App approval as a
strict per-head merge gate, its governance must dismiss stale approvals on
push or provide an equivalent current-head rule; this skill neither changes
nor guarantees that policy.

Permission upgrade, missing installation/repository access, stale head,
invalid run/session, and unknown GitHub delivery all fail closed. Never retry
an unknown delivery or switch to the local user credential. Cloud reconciles
the hidden run marker before it can report a submitted review.

Blocking findings may request changes on a draft. Never call `gh pr comment`
or `gh pr review` for the same outcome and never submit more than one review in
a run.

### 6. Report completion

In the reviewer chat, report the reviewed head SHA, the App actor, review id,
and GitHub review action actually returned by the submit command, plus any human
follow-up. If no review
was submitted because the head was stale or execution failed, say so plainly;
do not claim that the pull request passed.
