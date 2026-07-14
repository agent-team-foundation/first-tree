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
skill and it does not audit stored context on the default branch.

## Read-Only Boundary

The only permitted external write is exactly one GitHub pull request review on
an unchanged current head. Do not edit tree files, commit, push, open a repair
pull request, merge, change review settings, or post a top-level pull request
comment. Do not approve a pull request authored by the active GitHub identity.

## Workflow

### 1. Resolve the live pull request and reviewer identity

1. Read `.first-tree/workspace.json` and the generated Tree Location section.
   Resolve the bound tree checkout and normalize its `origin` repository
   identity. Do not guess from a webhook URL alone.
2. Use `gh pr view` to read the current repository, number, state, draft flag,
   author, base ref/OID, head ref/OID, URL, title, body, and changed files. Treat
   event payload values as hints; GitHub current state controls the verdict.
3. Confirm that the pull request repository is the workspace's bound Context
   Tree repository. Stop for ordinary code repositories or another team's tree.
4. Run `gh api user --jq .login` and record whether the active login is the pull
   request author. Continue the content review even when self-approval is
   blocked so the review can still report a complete safe-or-blocked outcome.
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
4. Compute the complete base-to-head diff locally and classify changed paths by
   the generated policy's content classes. For mixed changes, review the
   governed classes independently and treat supporting material only as
   evidence.

Always remove the detached worktree through `git worktree remove` after the
review attempt, including execution-failure and stale-head paths. Never use
`--force`; a dirty worktree is a review-integrity failure, not cleanup input.

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

Write the complete review body to a temporary Markdown file outside the
detached tree worktree. Before submitting, run `gh pr view` again and re-read
`state`, `isDraft`, and `headRefOid`.

- If the head changed, or the pull request closed/merged, submit zero reviews.
  Report the stale/current state and let a later event trigger a fresh run.
- Structural or semantic blocker: submit exactly one
  `gh pr review --request-changes --body-file <file>`.
- Human authority or source evidence is required to decide: submit exactly one
  `gh pr review --comment --body-file <file>` whose first heading is
  `## Human decision required`.
- No blocker, but the pull request is draft: submit exactly one comment review
  whose first heading says approval is deferred until ready.
- No blocker, but the active GitHub identity is the author: submit exactly one
  comment review whose first heading is `## Independent approval required`.
- Archive/supporting-only or repository-infrastructure-only: submit exactly one
  comment review explaining that semantic governance is out of scope.
- No blocker, ready pull request, unchanged current head, and independent
  active identity: submit exactly one
  `gh pr review --approve --body-file <file>`. A comment review, top-level
  comment, or chat statement is not a successful substitute for approval.

Blocking findings may request changes on a draft. Never call `gh pr comment`
for the same outcome and never submit more than one review in a run.

### 6. Report completion

In the reviewer chat, report the reviewed head SHA, the GitHub review action
actually submitted, and any human or independent-review follow-up. If no review
was submitted because the head was stale or execution failed, say so plainly;
do not claim that the pull request passed.
