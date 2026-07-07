---
name: first-tree-write
version: 0.9.0
cliCompat:
  first-tree: ">=0.5.0 <0.6.0"
description: Source-driven Context Tree write workflow. Use when a concrete source artifact such as a PR, issue, design doc, meeting note, review thread, or pasted source material should be reflected into the Context Tree. If no source artifact is available, there is no write task; ask the user for one.
---

# First Tree Write

Use this skill when a specific source artifact should be reflected into the
Context Tree. The generated `AGENTS.md` / `CLAUDE.md` Context Tree Policy is
the baseline for what belongs in the tree; this skill applies that policy to a
source-backed write.

Use `first-tree-read` for task-scoped tree reads before acting. Use this skill
only for source artifact -> tree edit work.

## Source Gate

Writing is source-driven. Acceptable sources include:

- a PR, issue, commit discussion, or review thread;
- a design doc, meeting note, decision note, or pasted source material;
- a source repo change you just completed, when its design decision now needs
  durable tree context.

If no concrete source artifact exists, stop and ask for one. Do not invent
ad-hoc tree edits from memory or from a broad request like "update the tree".

Implementation-only material usually produces no tree write. Refactors,
function signatures, API shapes, request/response examples, build config,
fixtures, and one-off bug fixes stay in source repos unless the source also
establishes a durable decision, constraint, ownership change, or cross-domain
relationship.

## Workflow

1. **Read the source artifact.** If you authored the source in this chat and
   still have it in working context, you may rely on that context. Otherwise
   read the artifact end to end: PR diff plus linked issue/review comments, or
   the document/note in full.
2. **Apply the Double Test.** A candidate belongs only when it both establishes
   or changes a decision future agents must respect and remains durable if the
   triggering commit or PR is rewritten. If nothing passes, write nothing and
   explain why.
3. **Select the smallest target.** Prefer editing an existing node. Add a leaf
   only for a distinct decision with its own rationale/constraints. Add a
   directory only when the domain shape justifies it; new top-level domains
   require explicit human-owner approval.
4. **Read surrounding tree context.** Before drafting, read the target node,
   parent `NODE.md`, relevant `soft_links` targets, and ownership-adjacent
   `members/<id>/NODE.md` files when they affect the edit. You do not need to
   re-read nodes already in working context; the requirement is no surprises.
5. **Draft the edit.** Capture current truth and present-tense rationale.
   Rewrite superseded claims in place; do not append timeline updates. Keep
   canonical content in one place and use normal-to-normal `soft_links` when a
   cross-domain reader needs navigation.
6. **Verify.** Run `first-tree tree verify --tree-path <tree>` before commit.
   Non-zero exit blocks the PR.
7. **Prepare the PR.** One source artifact maps to one tree PR. Keep the PR
   description focused on the source and the tree nodes changed; do not put PR
   IDs, source links, or audit trails into node bodies.

## Write Rules

- **Default to not writing.** A missing node is a question; a noisy node is a
  trap. The source carries the burden of proof.
- **No code detail in nodes.** Tree prose records the decision and rationale,
  not the implementation.
- **No history.** Nodes state what is true now and why. Past states live in
  `git log` and, when present, raw/archive material.
- **No Source section.** Do not add `## Source`, `Shipped in #123`, inline PR
  citations, or delivery-history prose to node bodies.
- **No actionable future work in normal nodes.** Put follow-up work in an
  issue, source artifact, or human decision.
- **Do not unilaterally edit `owners`.** Ownership changes go through humans.
- **Respect `decisionLocksCode: true`.** Normally code is ground truth when the
  tree drifts. This flag reverses that for the node; code drift escalates to a
  human. Set it only on explicit human instruction.

## Node Shape Reminder

Required frontmatter:

```yaml
---
title: "Short noun phrase"
owners: [alice, bob]
---
```

Useful optional frontmatter:

```yaml
description: "One-sentence summary used by readers and generated indexes."
soft_links:
  - /other-domain/NODE.md
decisionLocksCode: false
```

Prefer body sections in this order, omitting any that do not apply:

1. `## Decision` — the current durable claim.
2. `## Rationale` — why this choice; why alternatives lost.
3. `## Constraints` — what future implementation must respect.
4. `## Cross-Domain` — relationship prose when `soft_links` alone is not
   enough.

A concise node that captures the decision clearly is better than a long node
that mirrors source detail.

## CLI Surface

Examples use `first-tree`; substitute the channel-correct binary from the
generated briefing when running in staging or dev.

The write gate is:

```bash
first-tree tree verify --tree-path <tree>
```

Everything else uses standard tools: `git` for branches/commits, `gh` for
GitHub reads and PRs, and native file reads/edits for Markdown.
