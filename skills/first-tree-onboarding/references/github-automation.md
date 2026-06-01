# GitHub Automation During Onboarding

This reference backs Phase D.5 in `SKILL.md`.

## The split

- **Tier 0** — `validate.yml`, installed by default, rule-based, no secrets.
- **Tier 1** — AI PR review, not installed by this skill, owned by `first-tree cloud`.
- **Tier 2** — `owners:` gate plus `auto-merge.yml` / `review-enforcer.yml`, optional, rule-based, but tied to GitHub rulesets and App setup.

The onboarding skill owns Tier 0 by default and can help stage Tier 2. It does
not install Tier 1.

## Current parity target

The goal is not to literally copy files out of `first-tree-context`, but the
rule layer the skill teaches should be functionally similar to what
`first-tree-context` uses today:

| File / layer          | Role                                                                                       | Installed by default? | Owned by         |
| --------------------- | ------------------------------------------------------------------------------------------ | --------------------- | ---------------- |
| `validate.yml`        | Run `first-tree tree verify` on every PR                                                   | yes                   | onboarding skill |
| `auto-merge.yml`      | Classify a PR by `owners:` / `members/` rules and auto-approve / auto-merge the safe cases | no, opt-in            | onboarding skill |
| `review-enforcer.yml` | Dismiss non-owner approvals on cross-owner PRs                                             | no, opt-in            | onboarding skill |
| AI PR review          | Summaries, comments, model calls, First Tree Cloud dispatch                                | no                    | `first-tree cloud` |

That is the practical meaning of "set up the tree repo like `first-tree-context`
does today" for the current product surface.

## What "proper automation" means

For the current rule layer, "proper GitHub automation" means all of these are
true:

1. The tree repo has `validate.yml` in `.github/workflows/`.
2. If Tier 2 is enabled, the tree repo also has `auto-merge.yml` and `review-enforcer.yml` on the default branch.
3. The tree repo's frontmatter and `members/` layout are stable enough that the rule layer can classify PRs from tree state alone.
4. The GitHub App + ruleset prerequisites for Tier 2 are in place before enforcement is turned on.
5. The agent never improvises around secrets or repo-policy changes. It can prepare files and commands; the user executes the risky GitHub steps.

The skill should teach agents this full picture, not just "run one command."

## Tier 0 details

Tier 0 is intentionally minimal:

- Trigger: every PR
- Runtime: `actions/checkout@v4` + `actions/setup-node@v4`
- Verification: `first-tree tree verify`
- Safety properties: no secrets, no App install, no branch ruleset changes

The tree repo should always end onboarding with Tier 0 present, even if the
user skips Tier 2 and even if they have not published the tree yet.

## Tier 2 workflow semantics

Tier 2 is the current rule-only approximation of the `first-tree-context`
owners gate. The two workflow templates plus the GitHub ruleset work together
as one system.

### `auto-merge.yml`

This workflow classifies a PR into one of three buckets:

- **personal**
  The PR only changes `members/<author>/**` and every commit's committer is the
  author.
- **self-owner / `[ * ]` expansion**
  The author is in the intersection of frontmatter `owners:` across all changed
  files. `owners: [*]` expands to all members' GitHub usernames from
  `members/<*>/NODE.md`.
- **cross-owner**
  Everything else.

Expected behavior:

- `personal` -> gate bot can approve -> auto-merge can be enabled once `validate` is green
- `self-owner` -> gate bot can approve -> auto-merge can be enabled once `validate` is green
- `cross-owner` -> no auto-approval, no auto-merge; a listed owner must review

### `review-enforcer.yml`

This workflow exists because GitHub's built-in "1 approval required" rule is
too coarse for the tree's ownership model.

Expected behavior:

- On every approved review, re-classify the PR from base-branch tree state.
- If the PR is `cross_owner`, only reviewers in the owner intersection count.
- If the reviewer is not eligible, dismiss the approval.

Without this companion workflow, any write-capable reviewer could satisfy the
ruleset's approval count, which is not the rule we want.

## Tier 2 prerequisites

Agents should know the current prerequisites up front before teaching a user to
enable Tier 2:

### Tree-shape prerequisites

- `members/` must exist and be meaningful.
- Markdown files that participate in the gate must have usable `owners:`.
- The repo should treat base-branch tree state as the source of truth for PR classification.

### GitHub prerequisites

- GitHub App: `first-tree-gate`
- Repo secrets used by the current workflow comments and setup guidance:
  - `GATE_APP_ID`
  - `GATE_APP_PRIVATE_KEY`
- Ruleset required checks:
  - `validate`
  - `gate`
- Pull request rule:
  - require 1 approval
  - do not require CODEOWNERS review
- Classic branch protection on the same branch should be removed before the
  ruleset becomes active, otherwise GitHub stacks the old and new constraints.

The skill should not invent alternative secret names, alternate check names, or
alternate App identity unless the product itself changes.

## Tier 2 stages

Run:

```bash
first-tree tree automation install --tier 2 --tree-path <tree_root>
```

Interpret the returned `stage`:

- `write_rule_layer`
  The workflow files are missing, custom, outdated, or not yet merged onto the
  remote default branch.
- `create_ruleset`
  The workflow files are on the default branch, but the GitHub ruleset does not
  exist yet.
- `activate_ruleset`
  The ruleset exists, but is not yet active.
- `configured`
  Tier 2 is already active.

The agent should understand the rollout sequence behind those stages:

1. land the workflow files on the default branch
2. create the ruleset in `evaluate`
3. only after the user confirms, flip it to `active`

## Manual boundary

The onboarding skill may:

- write workflow files;
- show git diff;
- prepare a PR after explicit confirmation;
- print next commands.

The onboarding skill must not:

- paste secrets into chat;
- install the GitHub App for the user;
- execute the printed ruleset-changing `gh api` commands.

Those policy-changing commands stay manual even when the agent understands them,
because they are hard to reverse.

## What the agent should explain explicitly

When a user says "set up the tree repo with the proper GitHub rules," the agent
should be able to explain all of this from the skill alone:

- Tier 0 is safe and installed by default.
- Tier 1 is separate and belongs to First Tree Cloud, not to the onboarding skill.
- Tier 2 is rule-based and can mirror the current `first-tree-context` gate,
  but it depends on:
  - workflow files on the default branch
  - a GitHub App installation
  - a GitHub ruleset
  - stable `owners:` / `members/`
- The onboarding skill may write files and print commands.
- The onboarding skill must not execute the ruleset-changing `gh api` commands.

If the agent cannot say those things, it does not yet "have all the
information" needed to teach the setup reliably.

## What the agent should not improvise

The skill should keep agents from inventing ad hoc setup:

- Do not ask for provider API keys as part of tree onboarding.
- Do not install AI PR review into the tree repo as if it were Tier 0 or Tier 2.
- Do not create a different gate model such as "just use CODEOWNERS" unless the
  product docs change.
- Do not skip the `evaluate -> active` explanation when discussing Tier 2.
- Do not silently replace custom workflow files that have no template marker.

## Platform caveat

GitHub documents `enforcement: evaluate` as Enterprise-only. That means a
public or lower-tier test repo can still validate Tier 0 end to end and can
exercise Tier 2's file-writing and command-printing path, but may not support a
real `evaluate -> active` rollout.

That caveat is part of the setup knowledge the agent should carry when teaching
users. For lower-tier public repos, "similar to `first-tree-context`" may mean:

- Tier 0 fully real
- Tier 2 files real
- Tier 2 ruleset commands printed and explained
- final enforcement deferred or adapted to the repo plan
