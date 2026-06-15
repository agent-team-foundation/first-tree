---
name: first-tree-write
description: Operational workflow for source-backed Context Tree writes. Use only when the user asks Codex to write, update, reflect, capture, or record a concrete source artifact, design note, PR, issue, meeting note, or pasted source material into the Context Tree. Do not use for read-only Context Tree lookup, general coding tasks, casual prompts, or non-source-backed writing requests.
---

# First Tree Write

This skill owns the operational path from a concrete source artifact to the
right Context Tree target. It is self-contained for source-backed writes:
target selection, source filtering, drafting rules, ownership gates, and
verification all live here.

## Source Gate

Proceed only when the request includes a concrete source artifact or pasted
source material: a PR, issue, design doc, meeting note, decision note, review
thread, or equivalent source text.

If the source is absent, stop and ask for it. Do not write the tree from memory,
general preference, or an unsourced summary.

## Workflow

1. Resolve the workspace binding.
   - Walk upward from cwd to find `.first-tree/workspace.json`.
   - Read the manifest and resolve the tree repo as
     `<workspaceRoot>/<manifest.tree>`.
   - Stop if the binding is missing, malformed, or the tree directory does not
     exist.

2. Refresh the tree repo.
   - Run `git -C "$CONTEXT_REPO" fetch origin`.
   - Run `git -C "$CONTEXT_REPO" pull --ff-only` before reading or editing.
   - If the pull fails, report the git state and do not edit until the conflict
     is resolved or the user explicitly accepts the risk.

3. Inspect the tree shape before choosing a target.
   - Run `first-tree tree tree` from inside the context repo before picking a
     write location.
   - Use the listing to identify candidate existing nodes. Prefer an existing
     node whenever the source can be captured there without mixing unrelated
     decisions.
   - Create a new leaf only when the source has a distinct identity, anchor,
     and owner/linkability boundary.
   - Do not create a new top-level domain without explicit human tree-owner
     approval.

4. Make the intended target explicit before editing.
   - State the target path you intend to edit or create.
   - If creating a new leaf, state why an existing node is not the smallest
     correct edit.
   - If no candidate passes the Double Test, write nothing and explain why.

5. Read the source and surrounding tree context.
   - Read the source artifact in full unless you authored it in this same work
     context and already have it end-to-end.
   - Read the chosen target node, the parent `NODE.md`, relevant siblings, and
     any `soft_links` neighbors that may constrain the edit.
   - Read ownership-adjacent `members/<id>/NODE.md` files when ownership or
     review scope affects the write.

6. Apply the write rules in this skill.
   - Capture durable decisions, constraints, rationale, ownership, and
     cross-domain relationships only.
   - Leave implementation details, diffs, request shapes, constants, test
     fixtures, and local refactor mechanics in the source repo.
   - If the source does not pass the Double Test below, write nothing and
     explain why.

7. Edit and verify.
   - Keep the edit narrowly scoped to the chosen node or new leaf plus required
     parent index changes.
   - Run `first-tree tree verify` from the context repo before committing.
   - Non-zero verify output blocks the commit; fix the tree structure first.

## Write Rules

### Source-System Boundary

The tree is not a second source repo or implementation wiki. If a fact would
rot when the next refactor lands, keep it in the source system.

Write only durable material:

- decisions and current constraints a future agent must respect
- rationale that would not be obvious from the source diff alone
- ownership or review-path facts, when a human owner approves the change
- cross-domain relationships between tree topics

Do not write:

- function signatures, class names, request / response shapes, retry constants,
  feature flags, tests, fixtures, snapshots, or build settings
- step-by-step implementation walkthroughs
- bug fixes or refactors that do not change a public contract or durable
  decision
- source PR / issue / commit references inside node bodies

### Double Test

Before drafting, apply both questions to every candidate fact in the source:

1. **Decision question.** Does this source establish or change something a
   future agent must respect when making cross-domain choices?
2. **Durability question.** If the underlying PR, commit, or note were
   rewritten, would the decision still stand?

Write the candidate only when both answers are yes. If either answer is no,
leave it in the source repo and report the skipped write.

### Smallest Correct Edit

Default to editing an existing node. Add a new leaf only when the source cannot
fit an existing node without mixing unrelated decisions and the new leaf has a
clear identity, anchor, owner boundary, and linkability boundary.

Do not add a new directory or top-level domain as part of a routine write
unless a human tree owner explicitly approves the structural change.

### Current-State Prose

Write present-tense claims: what is true now and why it matters.

Do not append history narrative, update banners, "previously / originally"
paragraphs, "since <date>" status notes, or superseded-by footers. Past states
belong in `git log` and source history. When a decision changes, rewrite the
node in place so it states the new current truth.

### No PR References In Nodes

The triggering source proves that the write is grounded, but node bodies should
not cite delivery artifacts. Do not add `## Source` sections, `Shipped in #123`
notes, inline PR / issue / commit citations, or source-link footers.

The audit trail for which source changed the tree lives in git history and PR
descriptions, not in durable node prose.

### Ownership And `decisionLocksCode`

Do not unilaterally edit `owners`. Ownership changes require explicit human
approval from the relevant tree owner or listed owner.

`decisionLocksCode: true` reverses the usual drift default: the tree wins over
the code, and code drift should escalate to a human. Set or remove this flag
only on explicit human instruction.

### Verification Gate

Run `first-tree tree verify` from the context repo before committing. Non-zero
output blocks the commit.

## Output Expectations

Tell the user the target path and whether you edited an existing node or
created a new leaf. Mention skipped writes when the source fails the Double
Test or lacks a durable decision.

Do not commit unless the current workspace instructions explicitly allow it and
the user has confirmed the result.
