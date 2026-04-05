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

- A source/workspace Git repository, or an already-created dedicated tree repo
- Node.js 18+
- GitHub CLI (`gh`) if you want `context-tree publish` to create the remote
  `*-context` repo and open the source-repo PR for you
- The npm package is `first-tree`, the installed CLI command is
  `context-tree`.
- `context-tree init` installs the framework skill into
  `.agents/skills/first-tree/` and `.claude/skills/first-tree/`.
- Use `npx first-tree init` for one-off runs, or `npm install -g first-tree`
  to add the `context-tree` command to your PATH

### Step 1: Initialize

Recommended workflow: run `context-tree init` from your source or workspace repo.
The CLI will install the bundled skill in the current repo, update root
`AGENTS.md` and `CLAUDE.md` with a `FIRST-TREE-SOURCE-INTEGRATION:` line, and
create a sibling dedicated tree repo named `<repo>-context` by default. Tree
files are scaffolded only in the dedicated tree repo.

```bash
cd my-org
context-tree init
cd ../my-org-context
context-tree publish --open-pr
```

If you already created a dedicated tree repo manually, initialize it in place:

```bash
mkdir my-org-context && cd my-org-context
git init
context-tree init --here
```

Only use `--here` after you have already switched into the dedicated tree repo.
Do not use it inside the source/workspace repo unless you intentionally want
that repo itself to become the Context Tree.

Either way, the framework installs into `.agents/skills/first-tree/` and
`.claude/skills/first-tree/`, renders scaffolding (`NODE.md`, `AGENTS.md`,
`members/NODE.md`), and generates a task list in
`.agents/skills/first-tree/progress.md`.

Hard boundary: do **not** create `NODE.md`, `members/`, or tree-scoped
`AGENTS.md` in the source/workspace repo. Those files belong only in the
dedicated `*-context` repo.

Default agent workflow after initialization:

1. Draft the initial tree version in the dedicated `*-context` repo.
2. Run `context-tree publish --open-pr` from that dedicated tree repo. It will
   create or reuse the GitHub `*-context` repo in the same owner/org as the
   source repo, add it back to the source/workspace repo as a `git submodule`,
   and open the source-repo PR.
3. After publish succeeds, treat the source repo's submodule checkout as the
   canonical local working copy for the tree. The temporary sibling bootstrap
   checkout can be deleted when you no longer need it.

### Step 2: Work Through the Task List

Read `.agents/skills/first-tree/progress.md`. It contains a checklist tailored
to the current state of the repo. Complete each task:

- Fill in `NODE.md` with your organization name, owners, and domains
- Add project-specific instructions to `AGENTS.md` below the framework markers
- Create member nodes under `members/`
- Optionally configure agent integration (for Claude Code, the installed hook
  assets live under `.claude/skills/first-tree/`)
- Copy validation workflows from
  `.agents/skills/first-tree/assets/framework/workflows/` to
  `.github/workflows/`

As you complete each task, check it off in
`.agents/skills/first-tree/progress.md` by changing `- [ ]` to `- [x]`.

### Step 3: Verify

```bash
context-tree verify
```

Or, from your source/workspace repo:

```bash
context-tree verify --tree-path ../my-org-context
```

This fails if any items in `.agents/skills/first-tree/progress.md` remain
unchecked, and runs deterministic checks (valid frontmatter, node structure,
member nodes exist).

Do not run `context-tree verify` in the source/workspace repo itself. That repo
only carries the installed skill plus the
`FIRST-TREE-SOURCE-INTEGRATION:` line.

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
| `context-tree init` | Install local source/workspace integration and create or refresh a dedicated tree repo. By default, running in a source/workspace repo creates a sibling `<repo>-context`; use `--here` only when you are already inside the dedicated tree repo. |
| `context-tree publish` | Publish a dedicated tree repo to GitHub, add it back to the source/workspace repo as a submodule, and optionally open the source-repo PR. |
| `context-tree verify` | Check the installed progress file for unchecked items + run deterministic validation. Use `--tree-path` when invoking from another working directory. |
| `context-tree upgrade` | Refresh the installed framework skill from the currently running `first-tree` npm package and generate follow-up tasks. Use `--tree-path` when invoking from another working directory. |
| `context-tree help onboarding` | Print this onboarding guide. |

---

## Upgrading the Framework

When the framework updates:

```bash
context-tree upgrade
```

`context-tree upgrade` refreshes `.agents/skills/first-tree/` and
`.claude/skills/first-tree/` from the skill bundled with the currently running
`first-tree` npm package, preserves your tree content, and generates follow-up
tasks in `.agents/skills/first-tree/progress.md`.

If you run `context-tree upgrade` in the source/workspace repo, it refreshes
only the local installed skill plus the `FIRST-TREE-SOURCE-INTEGRATION:` lines.
Run `context-tree upgrade --tree-path ../my-org-context` to upgrade the
dedicated tree repo itself.

If your repo still uses the older `skills/first-tree/` or `.context-tree/` layouts,
`context-tree upgrade` will migrate it to the current installed layout first.

To pick up a newer framework release, first run a newer package version, for
example `npx first-tree@latest upgrade`, or update your global `first-tree`
install before running `context-tree upgrade`.

---

## Further Reading

- `.agents/skills/first-tree/references/principles.md` — Core principles with detailed examples
- `.agents/skills/first-tree/references/source-workspace-installation.md` — Source/workspace install contract
- `.agents/skills/first-tree/references/ownership-and-naming.md` — How nodes are named and owned
- `AGENTS.md` in your tree — The before/during/after workflow for every task
