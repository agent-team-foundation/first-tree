# Boundary With `first-tree-write`

Sync and source-driven tree writes both end up changing the tree, so the
boundary matters.

## One-Line Rule

- **Sync** discovers what changed, fixes **structural** gaps directly,
  and hands off **substantive** gaps to `first-tree-write`.
- **`first-tree-write`** is given a specific source and turns it into a
  specific tree update target using its own writing rules and
  "default to not writing" filter.

Sync starts from the tree (Phase 2–3) **and** the code (Phase 4); it
asks "what disagrees?" and "what isn't registered?". A
`first-tree-write` starts from a PR / doc / note and asks "what
should the tree say about this?"

## Decision Table

| Situation                                                                               | Route                                                                  |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| User asks "is the tree up to date?"                                                     | sync                                                                   |
| User asks "audit drift since last release"                                              | sync                                                                   |
| User asks "does the tree cover everything in the code repos?"                           | sync (Phase 4 is the answer)                                           |
| Fresh tree just onboarded; user wants initial alignment pass                            | sync                                                                   |
| User says "PR #123 changed how auth works — reflect it in the tree"                     | `first-tree-write` with the PR as source                               |
| User pastes a meeting note about an architecture decision                               | `first-tree-write` with the note as source                             |
| Sync finds a `code-not-synced/structural` gap (new dir / repo / dep / member)           | sync auto-fixes (skeleton edit)                                        |
| Sync finds a `code-not-synced/substantive` gap (new RFC / AGENTS.md section / decision) | hand off to `first-tree-write` (always, not optional)                   |
| `first-tree-write` notices adjacent drift the user did not mention                      | finish the requested write task; suggest sync as a follow-up           |

## Why It Matters

If sync drafts decision prose from code, it stops being an auditor — it
becomes a content producer with no specific human-pointed source, and the
result is hard to review. The structural/substantive split preserves this:
sync only ever **registers** existing source structure (skeletons,
stubs, list entries); the moment a fix would require composing prose,
sync hands the source pointer to `first-tree-write` and stops.

If a source-driven `first-tree-write` starts auditing, it stops
being a focused author — it broadens into a sweep the user did not
request.

Keep the roles tight.

## Hand-Off Mechanics

When sync wants `first-tree-write` to take over a finding (always for
`code-not-synced/substantive`, optionally for `tree-stale` /
`tree-wrong` with a clear source pointer):

1. Stop the fix loop on that finding.
2. Surface the source pointer (PR, commit, doc, AGENTS.md section, RFC
   path) to the user. Be specific — line range, heading, or sha.
3. Suggest invoking `first-tree-write` with that pointer:
   `/first-tree-write source=<pointer>`.
4. Do not preemptively start drafting the tree update inside sync.
5. Do not chain into `first-tree-write` automatically — let the user /
   orchestrating agent decide which substantive findings are tree-worthy.

When a source-driven `first-tree-write` wants sync to follow up
on adjacent drift:

1. Finish the tree update the user asked for.
2. In the final summary, list the adjacent findings as "consider running
   sync over <domain>".
3. Do not chain into sync automatically.

## What Both Skills Share

- They both consume the bound tree repo from the managed First Tree
  integration block in `AGENTS.md` / `CLAUDE.md`.
- They both default to "code is the ground truth" except where
  `decisionLocksCode: true` is set on the node.
- They both must use `tree verify` before a final commit.

The shared concepts live in `first-tree-context`; sync owns broad drift
classification, and `first-tree-write` owns source-backed write methodology.
