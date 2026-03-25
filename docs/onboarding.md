# Context Tree Onboarding

You are setting up a **Context Tree** — the living source of truth for an organization. This document tells you what it is and how to bootstrap one.

---

## What Is a Context Tree

A Context Tree is a Git repository where every directory is a **domain** and every file is a **node**. Each node captures decisions, designs, and cross-domain relationships — the knowledge that would otherwise scatter across PRs, documents, and people's heads.

Key properties:

- **Nodes are markdown files.** Each directory has a `NODE.md` that describes the domain. Leaf `.md` files capture specific decisions or designs.
- **Every node has an owner.** Declared in YAML frontmatter. Owners approve changes to their nodes.
- **Organized by concern, not by repo or team.** An agent working on "add SSO" finds all auth context in one place — not split across 4 repos.
- **The tree is never a snapshot — it's the current state.** When decisions change, the tree updates. Stale nodes are bugs.

### Frontmatter Format

Every node has frontmatter:

```yaml
---
title: "Auth Architecture"
owners: [alice, bob]
soft_links: [/infrastructure/deployments]
---
```

- `owners` — who can approve changes. `owners: []` inherits from parent. `owners: [*]` means anyone.
- `soft_links` — cross-references to related nodes in other domains.

### What Belongs in the Tree

Information an agent needs to **decide** on an approach — not to execute it.

**Yes:** "Auth spans 4 repos: backend issues JWTs, frontend uses Better Auth, extension uses OAuth popup, desktop uses localhost callback."

**No:** The function signature of `auth_service.verify()` — that's in the code.

---

## Four Principles

1. **Source of truth for decisions, not execution.** The tree captures the *what* and *why*. Execution details stay in source systems.
2. **Agents are first-class participants.** The tree is designed for agents to navigate and update.
3. **Transparency by default.** Reading is open to all. Writing requires owner approval.
4. **Git-native.** Nodes are files, domains are directories. History, ownership, and review follow Git conventions.

---

## How to Set Up a Context Tree

### Prerequisites

- A Git repository for your tree (separate from your code repos)
- Python 3.10+
- `pip install context-tree`

### Step 1: Initialize

```bash
mkdir my-org-tree && cd my-org-tree
git init
context-tree init
```

This clones the framework into `.context-tree/`, renders scaffolding (`NODE.md`, `AGENT.md`, `members/NODE.md`), and generates a task list in `.context-tree/progress.md`.

### Step 2: Work Through the Task List

Read `.context-tree/progress.md`. It contains a checklist tailored to the current state of the repo. Complete each task:

- Fill in `NODE.md` with your organization name, owners, and domains
- Add project-specific instructions to `AGENT.md` below the framework markers
- Create member nodes under `members/`
- Optionally configure agent integration (e.g., Claude Code session hooks)
- Copy validation workflows to `.github/workflows/`

As you complete each task, check it off in `progress.md` by changing `- [ ]` to `- [x]`.

### Step 3: Verify

```bash
context-tree verify
```

This fails if any items in `progress.md` remain unchecked, and runs deterministic checks (valid frontmatter, node structure, member nodes exist).

### Step 4: Design Your Domains

Create top-level directories for your organization's primary concerns. Each needs a `NODE.md`:

```
my-org-tree/
  NODE.md              # root — lists all domains
  engineering/
    NODE.md            # decisions about architecture, infra, tooling
  product/
    NODE.md            # strategy, roadmap, user research
  marketing/
    NODE.md            # positioning, campaigns
  members/
    NODE.md            # team members and agents
    alice/
      NODE.md          # individual member node
```

### Step 5: Populate from Existing Work

For each domain, extract knowledge from existing repos, docs, and systems:

- Decisions and their rationale
- Cross-domain relationships and dependencies
- Constraints that aren't obvious from the code

The tree doesn't duplicate source code — it captures what connects things and why they were built that way.

---

## CLI Reference

| Command | Description |
|---------|-------------|
| `context-tree init` | Bootstrap a new tree. Clones framework, renders templates, generates task list. |
| `context-tree verify` | Check progress.md for unchecked items + run deterministic validation. |
| `context-tree upgrade` | Compare local framework version to upstream, generate upgrade task list. |

---

## Upgrading the Framework

After init, the seed-tree repo is added as a git remote (`context-tree-upstream`). When the framework updates:

```bash
context-tree upgrade
```

This compares your `.context-tree/VERSION` to upstream and generates a task list. The framework directory (`.context-tree/`) is upgradable without touching your content.

---

## Further Reading

- `.context-tree/principles.md` — Core principles with detailed examples
- `.context-tree/ownership-and-naming.md` — How nodes are named and owned
- `AGENT.md` in your tree — The before/during/after workflow for every task
