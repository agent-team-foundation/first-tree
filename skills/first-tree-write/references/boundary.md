# Boundary With `first-tree-sync`

Write and sync both produce tree changes; the boundary is what triggers
them.

## One-Line Rule

- **Write** is given a specific source and turns it into a specific tree
  update.
- **Sync** discovers what changed and decides what needs updating.

Write starts from a PR / doc / note and asks "what should the tree say
about this?" Sync starts from the tree and asks "is anything stale?"

## Decision Table

| Situation                                                                           | Skill                                   |
| ----------------------------------------------------------------------------------- | --------------------------------------- |
| User pastes a PR link and says "reflect this in the tree"                           | write                                   |
| User pastes a meeting note about a decision                                         | write                                   |
| User pastes raw text and asks for the tree implication                              | write                                   |
| GitHub Scan agent classifies a notification as `route=write`                        | write                                   |
| User asks "is the tree up to date?"                                                 | sync                                    |
| User asks "audit drift since last release"                                          | sync                                    |
| GitHub Scan agent classifies a notification as `route=sync`                         | sync                                    |
| Write notices the same domain has unrelated drift                                   | finish write; suggest sync as follow-up |
| Sync finds a `code-not-synced` drift the user wants captured from a specific source | hand off to write                       |

## Why It Matters

If write starts auditing, it stops being a focused author — it broadens
into a sweep the user did not request, and the resulting PR becomes
hard to review.

If sync starts producing new content with no specific source, it stops
being an auditor — there is no clear motivation for the new content
and reviewers cannot verify it.

Keep the roles tight.

## Hand-Off Mechanics

When write hands off to sync:

1. Finish the write task as the user originally scoped it.
2. In the final PR body or summary, add a "Suggested follow-up" listing
   the adjacent drift you noticed.
3. Do not invoke sync automatically.

When sync hands off to write:

1. Sync stops the fix loop on that one finding.
2. Sync surfaces the source pointer (PR, commit, doc) to the user.
3. The user (or the routing layer) invokes `first-tree-write` with that
   pointer.

## What Both Skills Share

- The bound tree repo from the managed First Tree integration block in
  `AGENTS.md` / `CLAUDE.md`.
- The "code is the ground truth" default with the `decisionLocksCode`
  escape hatch.
- The requirement to run `first-tree tree verify` before any final
  commit.
- The methodology in `../first-tree/SKILL.md` and its references.

The shared parts let `first-tree` whitepaper own the methodology; sync
and write own the _when_ and _what_ of applying it.
