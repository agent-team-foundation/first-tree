---
name: first-tree-write
description: Operational workflow for source-backed Context Tree writes. Use only when the user asks Codex to write, update, reflect, capture, or record a concrete source artifact, design note, PR, issue, meeting note, or pasted source material into the Context Tree. Do not use for read-only Context Tree lookup, general coding tasks, casual prompts, or non-source-backed writing requests.
---

# First Tree Write

This skill owns the operational path from a concrete source artifact to the
right Context Tree target. It does not replace `first-tree-context`; load
`skills/first-tree-context/SKILL.md` before drafting and apply its writing
rules as the source of truth.

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
     and owner/linkability boundary under the rules in `first-tree-context`.
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

6. Load and apply `first-tree-context`.
   - Read `skills/first-tree-context/SKILL.md`.
   - Apply the Double Test, smallest-correct-edit rule, source-system boundary,
     no code-detail rule, no history narrative rule, no PR-reference rule, and
     human gate for ownership changes.
   - Capture durable decisions, constraints, rationale, ownership, and
     cross-domain relationships only. Leave implementation detail in source.

7. Edit and verify.
   - Keep the edit narrowly scoped to the chosen node or new leaf plus required
     parent index changes.
   - Run `first-tree tree verify` from the context repo before committing.
   - Non-zero verify output blocks the commit; fix the tree structure first.

## Output Expectations

Tell the user the target path and whether you edited an existing node or
created a new leaf. Mention skipped writes when the source fails the Double
Test or lacks a durable decision.

Do not commit unless the current workspace instructions explicitly allow it and
the user has confirmed the result.
