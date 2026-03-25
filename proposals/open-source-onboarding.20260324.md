---
title: "Open Source Onboarding: Framework Package & Agent-Driven Setup"
owners: [286ljb]
---

# Open Source Onboarding: Framework Package & Agent-Driven Setup

## Problem

We want to open-source the Context Tree idea so other teams can adopt it. The onboarding flow needs to handle:

1. **Initial setup** — new user's agent sets up the tree in their repo
2. **Upgrades** — when we improve the framework, users can pull changes without losing their content
3. **Migration** — users with existing work need to populate the tree from their codebase

## Design Decisions

### The framework/content split

| Category | Who owns | Upgrade behavior |
|---|---|---|
| **Framework** — validation, CLI, principles, scripts, templates | Context Tree project | Overwrite on upgrade |
| **Content** — NODE.md files, leaf nodes, members | User | Never touched |
| **Composed** — AGENT.md | Both | Framework provides base section (between markers), user extends below |

### `.context-tree/` as the framework home

```
.context-tree/
  VERSION                        # framework version (covers all framework files + CLI)
  cli.sh                         # CLI entry point (wrapper script)
  principles.md                  # core principles
  ownership-and-naming.md        # naming & ownership model
  validate_nodes.py              # node validation script
  cli/                           # CLI package (Python)
    __main__.py                  # entry point
    init.py                      # init command
    upgrade.py                   # upgrade command
    verify.py                    # verify command
    repo.py                      # repo inspection utilities
    rules/                       # task generation rules
      __init__.py
      framework.py
      root_node.py
      agent_instructions.py
      members.py
      agent_integration.py
      ci_validation.py
  scripts/
    inject-tree-context.sh       # utility: inject NODE.md at session start
  examples/
    claude-code/                 # Claude Code integration example
    codex/                       # Codex integration example
    kael/                        # Kael integration example
  workflows/
    validate.yml                 # GitHub Actions workflow
  templates/
    root-node.md.template        # scaffold for root NODE.md
    agent.md.template            # base AGENT.md (includes core ideas)
    member-node.md.template      # scaffold for member nodes
```

Upgrade = overwrite this directory from upstream. Content outside is untouched.

### Agent-agnostic integration

Context Tree is not tied to any specific agent. The framework provides reusable scripts and per-agent examples. How to wire scripts into a specific agent is a setup task — the CLI generates instructions based on which agent the user chooses.

If the CLI can't detect which agent the user runs, it skips agent-specific setup and notes it in the task list. The user or agent can configure this later.

### Composed files use marker-based injection

For `AGENT.md`:

```markdown
<!-- BEGIN CONTEXT-TREE FRAMEWORK — do not edit this section -->
(framework agent instructions — core ideas, workflow, principles)
<!-- END CONTEXT-TREE FRAMEWORK -->

# Project-Specific Instructions

(user's additions)
```

Upgrade rewrites only between the markers. AGENT.md includes the core ideas of Context Tree so any agent reading it understands the philosophy.

### Documentation lives in the tree

No separate white paper. The documentation IS the tree:

- `principles.md` — the core ideas
- `about.md` — what Context Tree is and who it's for
- `infrastructure.md` — the six pillars
- `ownership-and-naming.md` — naming and ownership model
- `AGENT.md` — includes core ideas so agents understand the philosophy

The template repo ships all of these. The website links to them.

---

## The CLI

### Philosophy

The CLI is a **harness for the agent**, not an executor. It assesses the repo, generates a situation-aware task list, and the agent does the work. Every team's situation is different — the agent adapts.

### Invocation

Python does not allow dot-prefixed directory names as package imports, so `.context-tree/cli.sh` won't work. Instead, the CLI is invoked via a wrapper script:

```bash
.context-tree/cli.sh init
.context-tree/cli.sh upgrade
.context-tree/cli.sh verify
```

`cli.sh` is a thin wrapper that calls `python .context-tree/cli/__main__.py "$@"`. This keeps the framework directory name (`.context-tree/`), avoids Python import issues, and works cross-platform.

Zero install — the CLI ships with the framework. No pip, no npx, no package manager.

### Commands

- **`init`** — Assess the repo, generate an onboarding task list. Must be run inside a git repo; returns an error otherwise so the agent knows to initialize a repo first.
- **`upgrade`** — Compare the local `.context-tree/VERSION` against the upstream template repo, generate an upgrade task list.
- **`verify`** — Run deterministic checks against the repo, report pass/fail.

### Output: stdout + progress file

Commands output the task list to **stdout** (so the agent gets it immediately) AND write a **progress file** at `.context-tree/progress.md`.

The progress file is mandatory for tracking. The agent checks off tasks as it completes them. If the session breaks or context is lost, the next agent picks up where the last one left off by reading the progress file.

- `.context-tree/progress.md` — persistent, agent-updated, survives session breaks
- Should be `.gitignore`d — it's operational state, not content
- `context-tree verify` cross-checks the progress file against actual repo state (e.g., a task marked done but the file doesn't exist = verification failure)

### Rules are Python functions

Each rule is a Python module under `.context-tree/cli/rules/`. The CLI loads all rule modules, calls `evaluate(repo)` on each, and assembles the task list from the results.

```python
# .context-tree/cli/rules/agent_integration.py
def evaluate(repo):
    tasks = []
    if repo.path_exists(".claude/settings.json"):
        if not repo.file_contains(".claude/settings.json", "inject-tree-context"):
            tasks.append(
                'Add SessionStart hook to `.claude/settings.json`'
                ' (see `.context-tree/examples/claude-code/`)'
            )
    elif not repo.any_agent_config():
        tasks.append(
            'No agent configuration detected. Configure your agent to load'
            ' tree context at session start. See `.context-tree/examples/`'
            ' for supported agents. You can skip this and set it up later.'
        )
    return {"group": "Agent Integration", "order": 5, "tasks": tasks}
```

The `repo` object provides check functions (`path_exists`, `file_contains`, `frontmatter`, etc.) that rules use to inspect repo state. Adding a new rule = adding a new Python file. No template engine, no custom DSL.

### Task list output

The CLI evaluates all rules and produces a grouped markdown task list. Each group covers a concern; items are conditional based on repo state.

Output example for `init` (existing repo, no template cloned):

```markdown
# Context Tree Init

## Framework
- [ ] `.context-tree/` not found — clone the template repo and copy `.context-tree/` into your repo, or add it as a git remote (see Upgrade Flow below)

## Root Node
- [ ] NODE.md is missing — create from `.context-tree/templates/root-node.md.template`, fill in your project's domains

## Agent Instructions
- [ ] AGENT.md is missing — create from `.context-tree/templates/agent.md.template`
- [ ] Add your project-specific instructions below the framework markers

## Members
- [ ] `members/` directory is missing — create it with a NODE.md
- [ ] Add at least one member node for a team member or agent

## Agent Integration
- [ ] `.claude/settings.json` found — add SessionStart hook to load NODE.md (see `.context-tree/examples/claude-code/`)

## CI / Validation
- [ ] No validation workflow found — copy `.context-tree/workflows/validate.yml` to `.github/workflows/`

## Verification
After completing the tasks above, run `.context-tree/cli.sh verify` to confirm:
- [ ] `.context-tree/VERSION` exists
- [ ] Root NODE.md has valid frontmatter (title, owners)
- [ ] AGENT.md exists with framework markers
- [ ] `validate_nodes.py` passes with no errors
- [ ] At least one member node exists
```

Output example for `init` (freshly cloned template — most framework files already in place):

```markdown
# Context Tree Init

## Root Node
- [ ] NODE.md has placeholder content — fill in your project's domains and description

## Agent Instructions
- [ ] Add your project-specific instructions below the framework markers in AGENT.md

## Members
- [ ] Add member nodes for your team members and agents under `members/`

## Agent Integration
- [ ] No agent configuration detected — configure your agent to load tree context at session start. See `.context-tree/examples/` for supported agents. You can skip this and set it up later.

## Verification
After completing the tasks above, run `.context-tree/cli.sh verify` to confirm:
- [ ] Root NODE.md has valid frontmatter (title, owners)
- [ ] AGENT.md exists with framework markers
- [ ] `validate_nodes.py` passes with no errors
- [ ] At least one member node exists
```

Output example for `upgrade`:

```markdown
# Context Tree Upgrade — v0.1.0 → v0.2.0

## Changelog
- Added `empty-nodes` check to validate_nodes.py
- Updated principles.md with new section

## Framework
- [ ] Pull latest from upstream: `git fetch context-tree-upstream && git merge context-tree-upstream/main`
- [ ] Resolve any conflicts in `.context-tree/` (framework files should generally take upstream version)

## Agent Instructions
- [ ] AGENT.md framework section is outdated — update content between markers to match new template

## Verification
- [ ] `.context-tree/VERSION` reads `0.2.0`
- [ ] `validate_nodes.py` passes
- [ ] AGENT.md framework section matches upstream
```

### `verify` is deterministic code

Unlike `init` and `upgrade` (which produce checklists for agents), `verify` runs actual checks and reports pass/fail. It subsumes `validate_nodes.py` and adds framework-level checks:

- `.context-tree/VERSION` exists
- Root NODE.md has valid frontmatter (title, owners)
- AGENT.md exists and contains framework markers
- Every folder has a NODE.md
- All `validate_nodes.py` checks pass (owners, soft_links, folder structure, etc.)
- At least one member node exists under `members/`

---

## Versioning & Distribution

The CLI is bundled with the framework — not a separate package.

- **Single version**: `.context-tree/VERSION` tracks all framework files and the CLI together. One version, one upgrade path.
- **Zero install**: `.context-tree/cli.sh init` — no package manager needed.
- **Upgrades together**: when the user pulls a new framework version via git, they get the updated CLI automatically.
- **Language**: Python. `validate_nodes.py` already exists in Python; the CLI wraps and extends it.

SemVer (`MAJOR.MINOR.PATCH`):
- **PATCH** — bug fixes in task generation or verify checks
- **MINOR** — new task groups, new verify checks, new agent examples
- **MAJOR** — breaking changes to output format or framework structure

If the CLI outgrows bundling (e.g., needs complex dependencies, independent release cadence), extract to PyPI then. Not now.

---

## Upgrade Flow

Upgrades use **git upstream merge** (Option A). The template repo is added as a remote:

```bash
# One-time setup (done during init)
git remote add context-tree-upstream https://github.com/agent-team-foundation/seed-tree

# Upgrade
git fetch context-tree-upstream
git merge context-tree-upstream/main
```

Framework files (`.context-tree/`) rarely conflict with content files since they're in different paths. When conflicts do occur, the agent resolves them — framework files should generally take the upstream version; content files keep the user's version.

After merging, the agent runs `.context-tree/cli.sh upgrade` to check if any composed files (AGENT.md) need updating, then `.context-tree/cli.sh verify` to confirm everything is clean.

---

## Onboarding Flow (End-to-End)

The Context Tree is a **standalone repo** — it's the organizational memory, not a subdirectory of an existing project. One context tree per organization (or team), tracking knowledge across all repos, systems, and domains. This is how `first-tree` works: it's its own repo, separate from any product codebase.

### Phase 1: Bootstrap the tree

1. Human reads website → decides to try Context Tree
2. Human tells their agent: "Set up a context tree for our organization" — the template URL (`https://github.com/agent-team-foundation/seed-tree`) is provided on the website or docs
3. Agent clones `seed-tree` as a new standalone repo (e.g., `my-org/context-tree`). The template URL is preserved as a git remote (`context-tree-upstream`) for future upgrades.
4. Agent runs `.context-tree/cli.sh init` — CLI generates a task list
5. Agent works through the task list: fills in root NODE.md, configures AGENT.md, sets up agent integration

### Phase 2: Design the domain structure

6. Human and agent figure out the top-level domains together — these are the org's primary areas of concern (e.g., `backend/`, `product/`, `infrastructure/`, `marketing/`)
7. Agent creates the domain directories with NODE.md scaffolds
8. Human assigns an owner for each domain in the NODE.md frontmatter
9. Agent runs `.context-tree/cli.sh verify` to confirm the structure is valid

### Phase 3: Populate from existing work

10. For each domain, the owner (human or agent) extracts knowledge from existing repos, docs, and systems into the tree — decisions, cross-domain relationships, constraints, rationale
11. This is done per-domain: each owner points their agent at the relevant source repos and the agent populates NODE.md files and leaf nodes
12. This mirrors how `first-tree` was built — the tree doesn't duplicate source code, it captures the *why* and *how things connect* across systems

### Phase 4: Distribute ownership

13. Create GitHub issues for each domain owner to review and complete their domain's nodes
14. Domain owners iterate on their nodes — adding missing context, correcting decisions, linking cross-domain dependencies via soft_links
15. The tree grows incrementally as the team works — every completed task is an opportunity to update the tree

---

## Template Repo Structure

```
.context-tree/           # framework (upgradable)
  VERSION
  cli.sh                 # CLI entry point
  principles.md
  ownership-and-naming.md
  validate_nodes.py
  cli/
    __main__.py
    init.py
    upgrade.py
    verify.py
    repo.py
    rules/
      __init__.py
      framework.py
      root_node.py
      agent_instructions.py
      members.py
      agent_integration.py
      ci_validation.py
  scripts/
    inject-tree-context.sh
  examples/
    claude-code/
    codex/
    kael/
  workflows/
    validate.yml
  templates/
    root-node.md.template
    agent.md.template
    member-node.md.template

AGENT.md                 # framework markers + core ideas + placeholder
NODE.md                  # root scaffold with placeholder domains
about.md                 # what is context tree
infrastructure.md        # the six pillars
members/
  NODE.md                # members domain scaffold
```

---

## Open Items

- Exact scope of `verify` checks beyond what `validate_nodes.py` already does
