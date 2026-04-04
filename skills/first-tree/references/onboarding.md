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
- Node.js 18+
- The npm package is `first-tree`, the installed CLI command is
  `context-tree`, and the installed skill directory in the tree is
  `skills/first-tree/`
- Use `npx first-tree init` for one-off runs, or `npm install -g first-tree`
  to add the `context-tree` command to your PATH

### Step 1: Initialize

```bash
mkdir my-org-tree && cd my-org-tree
git init
context-tree init
```

This installs the framework skill into `skills/first-tree/`, renders scaffolding (`NODE.md`, `AGENT.md`, `members/NODE.md`), and generates a task list in `skills/first-tree/progress.md`.

### Step 2: Work Through the Task List

Read `skills/first-tree/progress.md`. It contains a checklist tailored to the current state of the repo. Complete each task:

- Fill in `NODE.md` with your organization name, owners, and domains
- Add project-specific instructions to `AGENT.md` below the framework markers
- Create member nodes under `members/`
- Optionally configure agent integration (e.g., Claude Code session hooks)
- Copy validation workflows from `skills/first-tree/assets/framework/workflows/` to `.github/workflows/`

As you complete each task, check it off in `skills/first-tree/progress.md` by changing `- [ ]` to `- [x]`.

### Step 3: Verify

```bash
context-tree verify
```

This fails if any items in `skills/first-tree/progress.md` remain unchecked, and runs deterministic checks (valid frontmatter, node structure, member nodes exist).

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
| `context-tree init` | Bootstrap a new tree. Installs the framework skill, renders templates, generates a task list. |
| `context-tree verify` | Check the installed progress file for unchecked items + run deterministic validation. |
| `context-tree upgrade` | Refresh the installed framework skill from the currently running `first-tree` npm package and generate follow-up tasks. |
| `context-tree help onboarding` | Print this onboarding guide. |

---

## Upgrading the Framework

When the framework updates:

```bash
context-tree upgrade
```

`context-tree upgrade` refreshes `skills/first-tree/` from the
skill bundled with the currently running `first-tree` npm package, preserves your
tree content, and generates follow-up tasks in
`skills/first-tree/progress.md`.

If your repo still uses the older `skills/first-tree-cli-framework/` path,
`context-tree upgrade` will migrate it to `skills/first-tree/` first.

To pick up a newer framework release, first run a newer package version, for
example `npx first-tree@latest upgrade`, or update your global `first-tree`
install before running `context-tree upgrade`.

---

## Further Reading

- `skills/first-tree/references/principles.md` — Core principles with detailed examples
- `skills/first-tree/references/ownership-and-naming.md` — How nodes are named and owned
- `AGENT.md` in your tree — The before/during/after workflow for every task
