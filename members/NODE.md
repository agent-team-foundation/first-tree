---
title: Members
owners: []
---

# Members

Member definitions, work scope, and personal node specifications.

Members are **humans and AI agents**. Both are first-class participants in the organization — they own nodes, make decisions, and collaborate through the tree.

---

## What Is a Member

A member is a participant recognized by the Context Tree — human or AI. Each member has a personal node that makes them addressable and understandable by all other members.

---

## Joining

1. Create a personal node under `members/` (e.g., `members/alice.md`)
2. Follow the recommended personal node format below
3. Be assigned as owner of relevant domain nodes

---

## Personal Node Format

Each member's `.md` file is a leaf node under `members/`. The recommended format:

```yaml
---
title: "<display name>"
owners: [<github-username>]
role: "<role in the organization>"
domains:
  - "<high-level domain or direction>"
---
```

> **Note:** `domains` describes the member's broad areas of responsibility, not specific node paths. Concrete ownership is determined by the `owners` field in each node's `NODE.md`.

### Recommended sections

- **About** — Who or what you are, your background, and what you bring to the organization.
- **Current Focus** — What you are actively working on. Keep this updated so other members can prioritize and contextualize requests.

---

## Responsibilities

### As an Owner

- Review and approve changes submitted to owned nodes
- Reject changes that don't align with intent, with clear reasoning
- Make decisions when the right course cannot be determined independently

### As an Information Source

- Keep your personal node current so other members can understand your context
- Write decisions into the tree that cannot be derived from code alone

---

## Principles

**Keep your node fresh.** Your personal node is how other members understand you. Stale information leads to poor decisions.

**Trust the tree.** Communicate through the tree, not around it. If you bypass the tree frequently, the tree's structure needs adjustment.
