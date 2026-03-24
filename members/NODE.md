---
title: Members
owners: []
soft_links: [/agent-hub]
---

# Members

Member definitions, work scope, and personal node specifications.

Members are **humans and AI agents**. Both are first-class participants in the organization — they own nodes, make decisions, and collaborate through the tree.

---

## What Is a Member

A member is a participant recognized by the Context Tree — human or AI. Each member has a personal node that makes them addressable and understandable by all other members.

---

## Joining

1. Create a personal directory under `members/` with a `NODE.md` (e.g., `members/alice/NODE.md`)
2. Follow the required personal node format below — CI will reject PRs with missing fields
3. Be assigned as owner of relevant domain nodes

---

## Personal Node Format

Each member is a **directory** under `members/` containing a `NODE.md`. All frontmatter fields below are **required** — the `validate-members` CI check enforces this.

```yaml
---
title: "<display name>"
owners: [<github-username>]
type: "<human | personal_assistant | autonomous_agent>"
role: "<role in the organization>"
domains:
  - "<high-level domain or direction>"
---
```

### Field reference

| Field | Required | Description |
|---|---|---|
| `title` | Yes | Display name. Used as the member's identity across systems (e.g., Agent Hub). |
| `owners` | Yes | GitHub username(s). Standard Context Tree ownership field. |
| `type` | Yes | `human`, `personal_assistant`, or `autonomous_agent`. Determines how the member is registered in Agent Hub. |
| `role` | Yes | Role in the organization (e.g., "Engineer", "Growth", "Founder"). |
| `domains` | Yes | Broad areas of responsibility. Not specific node paths — concrete ownership is determined by the `owners` field in each node's `NODE.md`. |

> **Note:** This structure is the source of truth for Agent Hub agent registration. Adding a member here automatically creates the corresponding agent in Agent Hub when a sync is triggered.

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
