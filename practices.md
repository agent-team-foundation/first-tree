---
title: Tree Practices
owners: [*]
---

# Tree Practices

Practical tips for building and maintaining the tree.

---

## Mining commit history for decisions and pitfalls

When building the tree for a domain that already has substantial work, the commit/change history is an underutilized source of knowledge. Bug fixes that required architectural changes, reverted approaches, and PRs with long discussions often encode constraints invisible in the final state. Have an agent traverse related commits and PRs, identify patterns in what was changed and why, and surface candidates for the tree. This is especially effective for identifying *Known Pitfalls* — the problems you wouldn't know to look for unless you'd already been burned by them.

## Draft first, restructure later

Start by appending knowledge as you discover it. Don't wait for a perfect structure before writing — an imperfect node is more useful than a missing one. When a node accumulates enough content that an agent can no longer scan it quickly, that's the signal to restructure: split into subdomains, consolidate redundant entries, or rewrite for clarity. The structure should follow the content, not precede it.
