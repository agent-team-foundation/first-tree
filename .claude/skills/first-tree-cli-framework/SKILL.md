---
name: first-tree-cli-framework
description: Work on the `first-tree` CLI repo and its shipped `.context-tree` framework. Use when Codex needs to modify or validate `context-tree` commands (`init`, `verify`, `upgrade`, `help onboarding`), update `.context-tree/` templates/workflows/scripts/docs, maintain validator or rule logic around `NODE.md`, `AGENT.md`, `members/`, `owners`, `soft_links`, `progress.md`, or `CODEOWNERS`, understand the full Context Tree maintenance model implemented in this repo, or onboard a user/team to the end-to-end first-tree workflow and demo path.
---

# First Tree CLI Framework

## Overview

Use this skill when the task depends on the exact behavior of the `first-tree` CLI or the Context Tree framework it ships to user repos. This skill is designed to be portable: if someone copies `skills/first-tree-cli-framework` into another environment, they can still learn the model, inspect a bundled snapshot of the relevant repo files, and get explicit CLI install/run instructions.

This skill supports two common modes:

- framework maintenance: changing the CLI, templates, validators, workflows, or shipped docs
- onboarding and demo delivery: walking someone through the product idea, initializing a tree, showing the first successful collaboration loop, and explaining how downstream automation should consume the tree

## Source Of Truth

- `skills/first-tree-cli-framework/` is the only source-of-truth copy that humans should edit.
- `.agents/skills/first-tree-cli-framework/` is a generated Codex discovery mirror.
- `.claude/skills/first-tree-cli-framework/` is a generated Claude Code mirror.
- After editing the source-of-truth copy inside the live repo, run `bash ./scripts/sync-skill-artifacts.sh` from this skill directory.

## Non-Negotiables

- Treat `first-tree` as the template source and CLI, not as a Context Tree repo itself.
- Preserve the contract that the CLI is a harness for agents: it scaffolds, prints task lists, and validates state; it does not replace human approval or perform all maintenance automatically.
- Keep `.context-tree/` generic. Anything in that directory can be copied into user repos by `context-tree init`.
- Keep decision knowledge in the tree and execution detail in source systems. Re-check this boundary in `references/context-tree-maintenance-principles.md` whenever a change makes it blurry.
- When the task is onboarding or demo oriented, teach the end-to-end user journey and the "why now" value, not just the raw command list.
- Do not imply that `first-tree` alone implements issue-driven coding automation or `first-tree-hub` orchestration. The tree is the shared source of truth; downstream repos and workflows are responsible for watching issues, routing agents, and opening PRs.

## Quick Start

1. Read `references/portable-quickstart.md`.
2. Read `references/repo-snapshot/AGENTS.md` and `references/repo-snapshot/README.md`.
3. Read `references/context-tree-maintenance-principles.md` for the operating model.
4. Read `references/context-tree-source-map.md` to locate the exact bundled files for the task.
5. Run `bash ./scripts/locate-context-tree-source.sh <topic>` when you want a task-specific reading list before opening files.
6. Use `./scripts/run-local-cli.sh <command>` from this skill directory:
   - inside a live `first-tree` checkout, it builds and runs the local CLI
   - outside the repo, it falls back to an installed `context-tree` binary if available
7. If you are maintaining the skill inside the live repo and you change the framework, source references, or source-of-truth skill files, refresh everything with `bash ./scripts/sync-skill-artifacts.sh`.

## User Journey / Aha Moments / Multi-Agent Flow

Use this as the default story when the task is "help me understand first-tree", "show the onboarding flow", "demo the product", or "explain how agents should use this in practice."

### User Journey

1. Start in the `first-tree` repo and ground the user in the product idea.
   - Read `references/repo-snapshot/README.md`, `references/repo-snapshot/docs/about.md`, and `references/repo-snapshot/docs/onboarding.md`.
   - Explain `first-tree` as the template source and CLI for Context Tree: a living source of truth for organizational decisions, not another static doc set.
2. Move from the product repo to the user's tree repo.
   - The user should clone or create a separate git repo for their tree.
   - Use `npx first-tree init` or an installed `context-tree init` inside that tree repo.
   - If the user works in Claude Code, point them to `.context-tree/examples/claude-code/` so the tree can be loaded at session start.
3. Initialize, personalize, and commit the first tree.
   - Complete `.context-tree/progress.md`.
   - Fill in `NODE.md`, `AGENT.md`, and `members/`.
   - Run `context-tree verify`.
   - Commit the initialized tree so teammates and agents can consume the same starting point.
4. Show a teammate consuming the tree. This is **aha moment 1**.
   - A teammate clones the tree repo and asks a question about a domain.
   - The agent reads the relevant nodes before answering.
   - The answer should come from the tree's decisions and relationships, not from ad hoc repo spelunking.
   - If the tree is missing or stale, the agent should say so and update the tree as part of the task.
5. Show issue-driven implementation. This is **aha moment 2**.
   - A teammate opens a GitHub issue in the relevant product repo.
   - Downstream automation should read the relevant tree nodes before implementation, use those nodes to plan the change, and open a PR that reflects the same constraints and ownership.
   - The PR should be consistent with the tree and should update the tree when the issue changes org knowledge.
6. Show coordinated agent work. This is **aha moment 3**.
   - If the environment includes `first-tree-hub` or another orchestrator, route the task to the right collaborating agents using the tree as the shared source of truth.
   - Each participating agent should read the same relevant nodes, communicate through the orchestrator, and converge on one coherent result instead of re-discovering context independently.

### Aha Moments

- **Aha moment 1: the tree answers real questions quickly.**
  - Success signal: the agent can answer a teammate's question by reading a small set of nodes and can point to the missing node if the answer is incomplete.
- **Aha moment 2: the tree improves code changes, not just docs.**
  - Success signal: an issue leads to a PR whose plan, implementation, and review all line up with the relevant tree nodes, without dropping important constraints.
- **Aha moment 3: multiple agents can collaborate without losing context.**
  - Success signal: a routing layer such as `first-tree-hub` can hand the task to multiple agents, and they still produce one aligned result because they all start from the same tree context.

### Multi-Agent Flow

When the task involves more than one human or agent, default to this flow:

1. Identify the domain from the user's question, issue, or task.
2. Read the root `NODE.md`, then the relevant domain `NODE.md`, then the specific leaf nodes that shape the decision.
3. Read `members/` to identify the human owner, any relevant `autonomous_agent`, and any `delegate_mention` for a `personal_assistant`.
4. If a human member has a `delegate_mention`, treat that assistant as the primary interface for routing and follow-up.
5. If `first-tree-hub` or another downstream orchestrator is available, pass along:
   - the relevant node paths
   - the triggering issue or question
   - the expected deliverable
   - any ownership or approval constraints from the tree
6. Require every collaborating agent to read the same tree context before proposing work.
7. Before finishing, ask whether the task changed durable knowledge. If yes, update the tree before calling the work complete.

### Delivery Boundaries

- `first-tree` owns the CLI, templates, validators, onboarding docs, and the generic Context Tree framework.
- The user's tree repo owns the actual organizational knowledge and member topology.
- Downstream repos such as `first-tree-hub` own issue watchers, agent routing, inter-agent communication, and PR creation.
- In demos and explanations, make this boundary explicit so users understand what `first-tree` guarantees and what must be wired up by the consuming environment.

## Command Workflow

- Run `./scripts/run-local-cli.sh --help` to confirm top-level usage.
- Run `./scripts/run-local-cli.sh help onboarding` to inspect the onboarding document wired through `src/onboarding.ts`.
- Run `./scripts/run-local-cli.sh init` to exercise framework copy, template rendering, upstream remote setup, and progress generation.
- Run `./scripts/run-local-cli.sh verify` to exercise progress checks plus node/member validation.
- Run `./scripts/run-local-cli.sh upgrade` to exercise upstream version comparison and upgrade task generation.
- Run `bash ./scripts/locate-context-tree-source.sh --list` to see the supported reading topics.
- Prefer the local runner while editing this repo. Use a published/global `context-tree` binary only when the task is explicitly about consumer-side usage outside the repo.

## Portable Snapshot

- `references/repo-snapshot/` contains a bundled snapshot of the key `first-tree` repo materials that this skill depends on.
- The snapshot includes:
  - the full current `.context-tree/` directory
  - docs that explain the product and onboarding model
  - CLI source files, rule modules, validator modules, and tests used by this skill
- When the skill is copied elsewhere, treat the snapshot as the portable source of truth.
- When the skill is used inside a live `first-tree` checkout, compare the snapshot against the live repo before making changes so you do not reason from stale copies.

## Task Playbooks

### CLI, Rules, and Validators

- Inspect the bundled command module in `references/repo-snapshot/src/` and the paired test file in `references/repo-snapshot/tests/`.
- If a change alters generated task text, also review `references/repo-snapshot/src/rules/*.ts`, `references/repo-snapshot/.context-tree/templates/`, and the bundled onboarding docs the task text points at.
- If a change alters validation behavior, inspect both `references/repo-snapshot/src/validators/*.ts` and any bundled workflow or template content that teaches users how to satisfy those checks.

### Framework Payload

- Read `references/repo-snapshot/.context-tree/principles.md`, `references/repo-snapshot/.context-tree/ownership-and-naming.md`, templates, workflows, and helper scripts before editing.
- Remember that framework edits affect every repo initialized or upgraded from `first-tree`.
- Keep workflow files, helper scripts, rule text, docs, and the bundled snapshot aligned. If one changes and the others still teach the old behavior, treat that as an incomplete change.

### Tree-Model Questions

- Start with `references/context-tree-maintenance-principles.md`.
- Follow the authoritative file links from `references/context-tree-source-map.md` instead of relying on memory.
- If philosophy and implementation disagree, diagnose the mismatch explicitly and then align docs to code or code to docs before stopping.

## Validation

- Default repo checks: `pnpm typecheck`, `pnpm test`, `pnpm build`
- Targeted CLI smoke checks:
  - `./scripts/run-local-cli.sh --version`
  - `./scripts/run-local-cli.sh help onboarding`
  - `./scripts/run-local-cli.sh --help`
- When changing `.context-tree/generate-codeowners.ts`, cover inheritance, additive leaf owners, and wildcard handling in tests.
- When changing validators, cover hard errors plus warnings/infos where applicable.

## References

- `references/portable-quickstart.md`: installation and usage guidance for a copied skill folder.
- `references/context-tree-maintenance-principles.md`: the maintenance philosophy, ownership model, member model, and validation invariants.
- `references/context-tree-source-map.md`: the authoritative file-by-file map for the bundled snapshot and nearby helper scripts.
- `references/repo-snapshot/`: the portable snapshot, including the full `.context-tree/` contents from this repo.
- `scripts/check-skill-sync.sh`: verify source-of-truth, generated mirrors, and bundled snapshot are all in sync.
