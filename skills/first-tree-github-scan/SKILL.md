---
name: first-tree-github-scan
version: 0.4.0-alpha.1
cliCompat:
  first-tree: ">=0.4.0 <0.5.0"
description: Agent skill for handling a single GitHub notification spawned by the First Tree github-scan daemon. Use when an agent needs to decide how to tag, comment on, escalate, or hand off a PR, issue, review request, mention, or CI event, and when it needs to choose between handling on GitHub or routing to `first-tree-sync` / `first-tree-write`. This is the agent behavior spec, not the human CLI operations guide for the daemon — for that, run `first-tree github scan --help`.
---

# First Tree Github Scan

Read these first:

- `../first-tree/SKILL.md`
- `../first-tree/references/functions.md`
- `../first-tree/references/anti-patterns.md`

## What This Skill Does

This skill is loaded by the daemon every time a new GitHub notification
arrives and a per-task agent is spawned. The agent's job is to:

1. classify the notification
2. set the right `github-scan:*` label and post any necessary comment
3. choose exactly one of four routes (`reply` / `human` / `sync` / `write`)
4. emit a `GITHUB_SCAN_RESULT:` line so the daemon can dispatch
   downstream work

This is not the operator-facing daemon guide. Humans running
`first-tree github scan install` / `start` / `doctor` should use the CLI
help, not this skill.

## When To Use This Skill

| Use this skill                                   | Use a different skill                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| The daemon spawned an agent for one notification | A user wants to onboard a repo → `first-tree-onboarding`                  |
| You need the tag table or comment template       | A user wants to audit drift → `first-tree-sync`                           |
| You need the route taxonomy                      | A user wants to write tree content from a source → `first-tree-write`     |
| You need to decide whether to involve a human    | An operator is debugging the daemon — use `first-tree github scan --help` |

## The Four Tags

```
github-scan:new      — initial state; daemon also restores via auto-revert
github-scan:wip      — agent has started real work
github-scan:human    — a human must step in
github-scan:done     — finished, no further action
```

Exactly one `github-scan:*` label per item at any time. Full lifecycle
and `gh` calls in [references/tags.md](references/tags.md).

## The Four Routes

```
reply  — handle on GitHub: labels / review / comments
human  — set github-scan:human and stop
sync   — load first-tree-sync SKILL.md and continue under that skill
write  — load first-tree-write SKILL.md and continue under that skill
```

Pick the most specific route that fits — see
[references/route-taxonomy.md](references/route-taxonomy.md) for the
selection algorithm and worked examples. Required final-line format:

```
GITHUB_SCAN_RESULT: status=<handled|skipped|failed> route=<reply|human|sync|write> summary=<one-line>
```

## Hard Rules

- **Do not edit the tree from this skill.** Routing to `sync` or `write`
  is how tree changes happen. Direct tree writes here are forbidden.
- **Do not invent new `github-scan:*` tags.** The four are the contract.
  Missing-label situations route to `human` with a `skipped` status.
- **One tag at a time.** When flipping state, remove the previous label
  in the same operation.
- **Set the terminal tag before posting the final comment.** Race
  conditions with the auto-revert otherwise confuse the daemon.
- **Never reply with code diffs or chain-of-thought.** Comments are
  short and decision-grounded — see
  [references/comments.md](references/comments.md).
- **Include the disclosure sentence verbatim** on every public comment.
  If quoting a user-requested string would change the disclosure, post
  the disclosure separately.
- **Route `human` only on the four triggers** in
  [references/when-human.md](references/when-human.md). Reassurance and
  size are not triggers.

## References

- [tags.md](references/tags.md) — the four-tag protocol, lifecycle
  diagram, `gh` invocations, auto-revert mechanic, missing-label
  fallback
- [route-taxonomy.md](references/route-taxonomy.md) — route definitions,
  selection algorithm, worked examples, `GITHUB_SCAN_RESULT` format
- [comments.md](references/comments.md) — required fields, tone, length,
  per-route templates, disclosure handling, what comments must never
  contain
- [when-human.md](references/when-human.md) — the four triggers (new
  decision / owner unclear / cross-domain impact / rules cannot pick)
  and anti-triggers
