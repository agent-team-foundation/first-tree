# Agent Instructions for Context Tree

You are working in a **Context Tree** — the source of truth for decisions across the organization. Read and follow this before doing anything.

## Before Every Task

1. **Read the root NODE.md** to understand the domain map.
2. **Read the NODE.md of every domain relevant to your task.** If unsure which domains are relevant, start from root and follow the structure — it's organized by concern, not by repo.
3. **Follow soft_links.** If a node declares `soft_links` in its frontmatter, read those linked nodes too. They exist because the domains are related.
4. **Read leaf nodes that match your task.** NODE.md tells you what exists in each domain — scan it and read the leaves that are relevant.

Do not skip this. The tree is already a compression of expensive knowledge — cross-domain relationships, strategic decisions, constraints. An agent that skips the tree will produce decisions that conflict with existing ones.

## During the Task

- **Decide in the tree, execute in source systems.** If the task involves a decision (not just a bug fix), draft or update the relevant tree node before executing.
- **The tree is not for execution details.** Function signatures, DB schemas, API endpoints, ad copy — those live in source systems. The tree captures the *why* and *how things connect*.
- **Respect ownership.** Each node declares owners in its frontmatter. If your changes touch a domain you don't own, flag it — the owner needs to review.

## After Every Task

Ask yourself: **Does the tree need updating?**

- Did you discover something the tree didn't capture? (A cross-domain dependency, a new constraint, a decision that future agents would need.)
- Did you find the tree was wrong or outdated? That's a tree bug — fix it.
- Not every task changes the tree, but the question must always be asked.

## Reference

For ownership rules, tree structure, and key files, see [NODE.md](NODE.md) and [ownership-and-naming.md](ownership-and-naming.md).
