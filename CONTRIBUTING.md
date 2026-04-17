# Contributing to first-tree

Thanks for helping improve `first-tree`.

This repository ships a thin `first-tree` umbrella CLI over three products
(`tree`, `breeze`, `gardener`) plus four lightweight skill payloads.

Naming note:

- `first-tree` is the npm package name.
- `first-tree` is also the installed CLI command.
- `skills/first-tree/` holds the entry-point skill payload (methodology,
  shared `references/`, routing to the product skills).
- `skills/tree/`, `skills/breeze/`, `skills/gardener/` hold the per-product
  operational skills.
- This source repo tracks `.agents/skills/<name>/` and `.claude/skills/<name>/`
  symlink aliases for each of the four skills so local agents can discover
  them without an install step.
- User repos install the four payloads at the same paths
  (`.agents/skills/<name>/` and `.claude/skills/<name>/`).

Most skill content changes should land in `skills/<name>/SKILL.md`, not in
the local alias paths, root-level prose, or ad hoc helper files.

## Before You Change Anything

- If you are trying to use Context Tree in your own repo, start with `README.md`
  and `skills/first-tree/references/onboarding.md` instead of this maintainer
  guide.
- If a change is large, cross-cutting, or changes the public contract, open an
  issue or draft PR first so maintainers can align on scope before
  implementation.
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

- Treat `skills/first-tree/` as the only canonical source of tree skill knowledge.
- If you change shipped payloads under `assets/tree/`, keep templates,
  task text, docs, and tests aligned.
- If you change anything that gets copied into user repos, bump
  `assets/tree/VERSION`.
- If you change installed layout or upgrade semantics, update
  `skills/first-tree/references/upgrade-contract.md` and the related tests in
  the same PR.
- If you change maintainer workflows or package shell behavior, update the
  relevant references under `skills/first-tree/references/`.

## Pull Requests

Helpful PRs for this repo usually include:

- a short explanation of the user-facing or maintainer-facing problem
- the affected command or package surface (`init`, `verify`, `upgrade`, help,
  templates, validators, or packaging)
- the validation commands you ran
- notes about package/install behavior if the published tarball changes

Use the GitHub issue forms for bug reports and feature requests, and follow the
pull request template when opening a PR so maintainers get the same core
context every time.

## Where To Start Reading

- `README.md` for the public entrypoint
- `skills/first-tree/SKILL.md` for the user-facing tree skill payload
- `docs/source-map.md` for the maintainer reading index
