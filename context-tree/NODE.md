---
title: Context Tree
owners: [286ljb]
soft_links: [/open-source, /agent-hub]
---

# Context Tree

The CLI and framework that lets any team bootstrap and maintain a context tree — a structured, agent-navigable knowledge base.

**Repo:** [first-tree](https://github.com/agent-team-foundation/first-tree)
**npm:** [first-tree](https://www.npmjs.com/package/first-tree)

---

## CLI

Three commands, all generating task lists for agents to execute:

| Command | What it does |
|---|---|
| `context-tree init` | Clone framework, render scaffolding (NODE.md, AGENT.md, members/NODE.md), generate onboarding task list |
| `context-tree verify` | Run node validation, member validation, frontmatter checks — report pass/fail |
| `context-tree upgrade` | Compare local `.context-tree/VERSION` to upstream, generate upgrade task list |

Install and run: `npx context-tree init` (published as `first-tree` on npm).

The CLI is a **harness for the agent** — it assesses the repo state and generates a situation-aware checklist. The agent does the work.

### Implementation

- **Language:** TypeScript, zero runtime dependencies (Node.js stdlib only)
- **Source:** `src/` in the first-tree repo
  - `src/repo.ts` — Repo class for inspecting tree state (frontmatter, files, git remotes)
  - `src/rules/` — Rule modules that evaluate repo state and produce task groups
  - `src/validators/` — Node validation, member validation, CODEOWNERS generation
  - `src/init.ts`, `src/verify.ts`, `src/upgrade.ts` — Command implementations


### Rules system

Each rule is a TypeScript module exporting `evaluate(repo): RuleResult`. Rules return `{ group, order, tasks }`. The CLI evaluates all rules, filters empty groups, and assembles a grouped markdown checklist.

Current rules (in order):
1. **Framework** — `.context-tree/VERSION` exists
2. **Root Node** — NODE.md exists with valid frontmatter, no placeholders
3. **Agent Instructions** — AGENT.md exists with framework markers, has user content
4. **Members** — `members/` exists with at least one member node
5. **Agent Integration** — Agent config detected (Claude Code, Codex, etc.)
6. **CI / Validation** — GitHub Actions workflow with validation steps

---

## Framework

The `.context-tree/` directory is shipped to every user's repo via `context-tree init`. It contains everything needed to validate and maintain a tree.

### What's in `.context-tree/`

| File | Purpose |
|---|---|
| `VERSION` | Framework version (single version covers all framework files) |
| `principles.md` | Core principles with examples |
| `ownership-and-naming.md` | Node naming and ownership model |
| `templates/` | Scaffolding templates (root-node, agent, members-domain, member-node) |
| `workflows/` | GitHub Actions workflows (validate, codeowners, pr-review) |
| `scripts/` | Utility scripts (inject-tree-context.sh) |
| `examples/` | Per-agent integration examples (Claude Code, Codex, Kael) |
| `prompts/` | Prompt templates (pr-review) |
| `run-review.ts` | PR review script for CI (invokes Claude Code, extracts structured JSON) |

### Framework/content split

| Category | Who owns | Upgrade behavior |
|---|---|---|
| **Framework** (`.context-tree/`) | Context Tree project | Overwrite on upgrade |
| **Content** (NODE.md, leaf nodes, members) | User | Never touched |
| **Composed** (AGENT.md) | Both | Framework section between markers; user extends below |

### Upgrade mechanism

`context-tree init` adds `context-tree-upstream` as a git remote pointing to the first-tree repo. Upgrading:

```
context-tree upgrade    # generates task list
git fetch context-tree-upstream && git merge context-tree-upstream/main
context-tree verify     # confirms everything is clean
```

---

## Onboarding flow

1. **Bootstrap** — User forks first-tree or runs `npx context-tree init` in a new git repo. CLI clones framework, renders templates, generates task list.
2. **Configure** — Agent works through the task list: fills in root NODE.md, configures AGENT.md, sets up agent integration.
3. **Design domains** — User and agent define top-level directories for the org's concerns. Each gets a NODE.md.
4. **Populate** — Per-domain, owners extract knowledge from existing repos, docs, and systems into the tree.
5. **Distribute ownership** — Assign owners in frontmatter. Domain owners iterate on their nodes.

---

## Validation

The CLI runs these checks via `context-tree verify`:

- `.context-tree/VERSION` exists
- Root NODE.md has valid frontmatter (title, owners)
- AGENT.md exists with framework markers
- Node validation passes (owners syntax, soft_links resolve, folder structure, directory listing, root domain sync, empty nodes, title mismatch)
- Member validation passes (required fields: title, owners, type, role, domains)
- At least one member node exists
- Progress file has no unchecked items
