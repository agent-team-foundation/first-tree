---
name: first-tree
description: Maintain the canonical `first-tree` skill and the thin `context-tree` CLI distributed by the `first-tree` npm package. Use when modifying `context-tree` commands (`init`, `verify`, `upgrade`, `help onboarding`), the installed skill payload under `assets/framework/`, maintainer references, or the build, packaging, test, and CI wiring that supports the framework.
---

# First Tree

Use this skill when the task depends on the exact behavior of the
`context-tree` CLI or the installed `.agents/skills/first-tree/` and
`.claude/skills/first-tree/` payloads that `context-tree init` ships to user
repos.

## Source Of Truth

- `skills/first-tree/` is the only canonical copy.
- `references/` holds the explanatory docs the skill should load on demand.
- `assets/framework/` holds the runtime payload that gets installed into user
  repos.
- `engine/` holds the canonical framework and CLI behavior.
- `scripts/` holds maintenance helpers for validating and running the skill.
- In maintainer docs, use `context-tree` for the CLI, `skills/first-tree/` for
  the bundled source path, and `.agents/skills/first-tree/` /
  `.claude/skills/first-tree/` for installed user-repo paths.

## When To Read What

1. Start with `references/source-map.md` to locate the right files.
2. Read the user-facing reference that matches the task:
   - `references/onboarding.md`
   - `references/about.md`
   - `references/principles.md`
   - `references/ownership-and-naming.md`
   - `references/upgrade-contract.md`
3. Read the maintainer reference that matches the shell or validation surface:
   - `references/maintainer-architecture.md`
   - `references/maintainer-thin-cli.md`
   - `references/maintainer-build-and-distribution.md`
   - `references/maintainer-testing.md`
4. Open `engine/` when changing `init`, `verify`, `upgrade`, command routing,
   repo inspection, rules, runtime helpers, or validators.
5. Open `assets/framework/` only when the task changes shipped templates,
   workflows, prompts, examples, or helper scripts.
6. Open `tests/` when changing validation coverage or maintainer workflows.
7. Use `./scripts/run-local-cli.sh <command>` when you need to exercise the
   live CLI from this repo.

## Working Modes

### Maintaining `first-tree`

- Treat this repo as the distribution source for one canonical skill plus a
  thin CLI shell, not as a tree repo.
- Keep command behavior, validator behavior, shipped assets, maintainer
  references, and package shell aligned.
- If root README/AGENTS/CI text explains something non-obvious, migrate that
  information into `references/` and trim the root file back down.
- If you change runtime assets or skill references, run `pnpm validate:skill`.

### Working In A User Tree Repo

- `context-tree init` defaults to creating or reusing a sibling dedicated tree
  repo when invoked from a source/workspace repo. Use `--here` to initialize
  the current repo in place when you are already inside the tree repo.
- `context-tree init` installs this skill into the target tree repo and
  scaffolds `.agents/skills/first-tree/`, `.claude/skills/first-tree/`,
  `NODE.md`, `AGENTS.md`, and `members/NODE.md`.
- `context-tree upgrade` refreshes the installed skill from the copy bundled
  with the currently running `first-tree` package. To pick up a newer
  framework, run a newer package version first. It also migrates older repos
  that still use `skills/first-tree/` or `skills/first-tree-cli-framework/`.
- The user's tree content lives outside the skill; the skill only carries the
  reusable framework payload plus maintenance guidance.
- The tree still stores decisions, constraints, and ownership; execution detail
  stays in source systems.

## Non-Negotiables

- Preserve the CLI contract that it scaffolds, prints task lists, and validates
  state; it does not fully automate tree maintenance.
- Keep shipped assets generic. They must not contain org-specific content.
- Keep decision knowledge in the tree and execution detail in source systems.
- Keep the skill as the only canonical knowledge source. The root CLI/package
  shell must not become a second source of framework semantics.
- Keep the CLI name written as `context-tree` in maintainer and user-facing
  docs so it is not confused with the `first-tree` package that ships it.
- Keep normal `init` / `upgrade` flows self-contained. They must work from the
  skill bundled in the current package without cloning the source repo or
  relying on network access.
- Make upgrade behavior explicit. If you change installed paths, update
  `references/upgrade-contract.md`, task text, and tests together.

## Validation

- Repo checks: `pnpm typecheck`, `pnpm test`, `pnpm build`
- Packaging check: `pnpm pack` when changing package contents or install/upgrade
  behavior
- Skill checks:
  - `pnpm validate:skill`
  - `python3 ./skills/first-tree/scripts/quick_validate.py ./skills/first-tree`
  - `bash ./skills/first-tree/scripts/check-skill-sync.sh`

## Key Files

- `assets/framework/manifest.json`: runtime asset contract
- `assets/framework/templates/`: generated scaffolds
- `assets/framework/workflows/`: CI templates
- `assets/framework/helpers/`: shipped helper scripts and review tooling
- `engine/`: canonical framework and CLI behavior
- `tests/`: canonical unit and structure validation
- `references/source-map.md`: canonical reading index
- `references/maintainer-architecture.md`: source-repo architecture and
  invariants
- `references/maintainer-thin-cli.md`: root shell contract
- `references/maintainer-build-and-distribution.md`: packaging and release
  guidance
- `references/maintainer-testing.md`: validation workflow
- `references/upgrade-contract.md`: installed layout and upgrade semantics
