# Comments

Public GitHub comments are the most visible thing this skill produces.
They must be short, decision-grounded, and disclosed.

## Required Fields

Every comment includes, in order:

1. **What you did or decided.** One sentence.
2. **Why.** A short rationale grounded in tree context — link the
   relevant tree node when one exists.
3. **Next step.** If you are setting `github-scan:human`, say what
   you need from the human. If you are setting `github-scan:done`, say
   "no further action expected." If you are routing to sync or write,
   name the skill.
4. **Disclosure sentence.** The daemon supplies an exact disclosure
   string per task; include it once verbatim. If preserving the
   user-requested wording would change the disclosure, post the
   disclosure as a separate comment instead of rewording it.

## Tone

- Direct. Avoid hedging language ("perhaps", "I think", "it might
  be").
- No internal chain-of-thought. The reader sees decisions, not
  reasoning steps.
- No broad repo analysis. If the analysis was relevant, the tree node
  link covers it.
- No emoji unless the user explicitly asked.

## Length

Aim for under 6 lines of body text. If you need more, you are probably
trying to write a tree update — stop and route to `write` instead.

## Templates

### `route=reply` (acknowledged, nothing to do)

```
Acknowledged. <one-sentence justification, e.g. "This mention is
informational; no tree or code change is needed.">

No further action expected.

<disclosure-sentence>
```

### `route=reply` (substantive answer)

```
<one-sentence summary of what you did or decided>.

Context: see <tree-node-title> (<tree-node-link>).

No further action expected.

<disclosure-sentence>
```

### `route=human`

```
Flagging for human review: <one-line on what is unclear>.

I cannot proceed because <specific reason: ownership/decision/cross-
domain impact>.

@<owner> — please <specific ask: confirm decision / pick option /
re-assign owner>.

<disclosure-sentence>
```

### `route=sync`

```
Routing to sync: <one-line on the suspected drift area>.

Continuing under \`first-tree-sync\` to audit <domain>.

<disclosure-sentence>
```

### `route=write`

```
Routing to write: this <PR / doc / note> establishes <one-line
decision>.

Continuing under \`first-tree-write\` to draft the tree update against
<tree-node-or-domain>.

<disclosure-sentence>
```

## What Comments Must NEVER Contain

- Code diffs.
- Lists of file paths or line numbers from the source repo (use links).
- Unredacted secrets, tokens, internal URLs, or chat snippets.
- Summaries of an entire PR's changes — link the PR description
  instead.
- Plans like "I will check X then Y then Z." Decide and act; report the
  decision.
- Apologies. State the action; do not perform.

## When To Reply Vs Review Vs Issue

| Surface       | Use when                                                                                              |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| PR comment    | The notification is on a PR and your action is comment-grade                                          |
| PR review     | You need to leave inline comments on specific lines, or block/approve                                 |
| Issue comment | The notification is on an issue                                                                       |
| New issue     | You need to track follow-up that the current item cannot hold (rare; usually `route=human` covers it) |

Default to commenting on the existing item. Creating a new issue is a
high-bar move that should follow user instruction or a clear policy in
the tree.
