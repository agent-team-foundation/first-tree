---
title: Tips for Working with Context Tree
owners: [*]
---

# Tips

Practical tips for working with the context tree efficiently.

---

## Claude Code Users

- **Start `claude` in the tree directory.** This makes the tree your primary working directory. The agent reads the tree first, which is the intended workflow.
- **Use `/add-dir` to add source repos.** When you need to explore or modify source systems, add the relevant repos as additional working directories.
- **Decide in the tree, execute in source systems.** Ask the agent to read tree nodes and draft a decision before diving into execution.
- **Tree context is auto-injected.** A hook in `.claude/settings.json` injects NODE.md at session start. If you use a different agent tool, configure its project instructions to do the same.
- **PRs are auto-reviewed.** A GitHub Action runs Claude on every PR to check tree structure, ownership, and consistency. You can also comment `@claude` on any PR to trigger a review.
