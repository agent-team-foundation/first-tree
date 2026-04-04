# Contributing to first-tree

Thanks for helping improve `first-tree`.

This repository ships one canonical framework skill plus a thin CLI shell. Most
changes should land in the canonical skill under
`skills/first-tree-cli-framework/`, not in root-level prose or ad hoc helper
files.

## Before You Change Anything

- If you are trying to use Context Tree in your own repo, start with `README.md`
  and `skills/first-tree-cli-framework/references/onboarding.md` instead of this
  maintainer guide.
- If a change is large, cross-cutting, or changes the public contract, open an
  issue or draft PR first so maintainers can align on scope before implementation.
- Keep root shell files thin. If a change needs framework-specific knowledge,
  move that knowledge into the skill references.

## Local Setup

Use the same baseline as CI:

- Node.js 22
- pnpm 10

Install dependencies from the repo root:

```bash
pnpm install --frozen-lockfile
```

## Validation

Run the standard checks before opening a PR:

```bash
pnpm validate:skill
pnpm typecheck
pnpm test
pnpm build
```

Also run this when package contents or install/upgrade behavior changes:

```bash
pnpm pack
```

Maintainer-only end-to-end evals live in `evals/`. Read `evals/README.md`
before running `EVALS=1 pnpm eval`.

## Change Discipline

- Treat `skills/first-tree-cli-framework/` as the only canonical source of
  framework knowledge.
- If you change shipped payloads under `assets/framework/`, keep templates,
  task text, docs, and tests aligned.
- If you change anything that gets copied into user repos, bump
  `skills/first-tree-cli-framework/assets/framework/VERSION`.
- If you change installed layout or upgrade semantics, update
  `skills/first-tree-cli-framework/references/upgrade-contract.md` and the
  related tests in the same PR.
- If you change maintainer workflows or package shell behavior, update the
  relevant references under `skills/first-tree-cli-framework/references/`.

## Pull Requests

Helpful PRs for this repo usually include:

- a short explanation of the user-facing or maintainer-facing problem
- the affected command or package surface (`init`, `verify`, `upgrade`, help,
  templates, validators, or packaging)
- the validation commands you ran
- notes about package/install behavior if the published tarball changes

## Where To Start Reading

- `README.md` for the public entrypoint
- `skills/first-tree-cli-framework/SKILL.md` for the maintainer workflow
- `skills/first-tree-cli-framework/references/source-map.md` for the canonical
  reading index
