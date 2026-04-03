---
name: first-tree-cli-framework
description: Work on the `first-tree` CLI and the single canonical `first-tree-cli-framework` skill it ships to Context Tree repos. Use when modifying `context-tree` commands (`init`, `verify`, `upgrade`, `help onboarding`), the installed skill payload under `assets/framework/`, or the decision/ownership model captured in the skill references.
---

# First Tree CLI Framework

Use this skill when the task depends on the exact behavior of the `first-tree`
CLI or the installed framework payload that `context-tree init` ships to user
repos.

## Source Of Truth

- `skills/first-tree-cli-framework/` is the only canonical copy.
- `references/` holds the explanatory docs the skill should load on demand.
- `assets/framework/` holds the runtime payload that gets installed or exported.
- `scripts/` holds maintenance helpers for validating, exporting, and running
  the skill.

## When To Read What

1. Start with `references/source-map.md` to locate the right files.
2. Read the specific reference that matches the task:
   - `references/onboarding.md`
   - `references/about.md`
   - `references/principles.md`
   - `references/ownership-and-naming.md`
   - `references/upgrade-contract.md`
3. Open `assets/framework/` only when the task changes shipped templates,
   workflows, prompts, examples, or helper scripts.
4. Use `./scripts/run-local-cli.sh <command>` when you need to exercise the
   live CLI from this repo.

## Working Modes

### Maintaining `first-tree`

- Treat this repo as the CLI and skill source, not as a tree repo.
- Keep command behavior, validator behavior, shipped assets, and the
  explanatory references aligned.
- If you change runtime assets, run
  `bash ./skills/first-tree-cli-framework/scripts/sync-skill-artifacts.sh`.

### Working In A User Tree Repo

- `context-tree init` installs this skill into the user's repo and scaffolds
  `NODE.md`, `AGENT.md`, and `members/NODE.md`.
- The user's tree content lives outside the skill; the skill only carries the
  reusable framework payload plus maintenance guidance.
- The tree still stores decisions, constraints, and ownership; execution detail
  stays in source systems.

## Non-Negotiables

- Preserve the CLI contract that it scaffolds, prints task lists, and validates
  state; it does not fully automate tree maintenance.
- Keep shipped assets generic. They must not contain org-specific content.
- Keep decision knowledge in the tree and execution detail in source systems.
- Make upgrade behavior explicit. If you change installed paths, update
  `references/upgrade-contract.md`, task text, and tests together.

## Validation

- Repo checks: `pnpm typecheck`, `pnpm test`, `pnpm build`
- Skill checks:
  - `python3 ./skills/first-tree-cli-framework/scripts/quick_validate.py ./skills/first-tree-cli-framework`
  - `bash ./skills/first-tree-cli-framework/scripts/check-skill-sync.sh`
  - `bash ./skills/first-tree-cli-framework/scripts/portable-smoke-test.sh`

## Key Files

- `assets/framework/manifest.json`: runtime asset contract
- `assets/framework/templates/`: generated scaffolds
- `assets/framework/workflows/`: CI templates
- `assets/framework/helpers/`: shipped helper scripts and review tooling
- `references/source-map.md`: canonical reading index
- `references/upgrade-contract.md`: installed layout and upgrade semantics
