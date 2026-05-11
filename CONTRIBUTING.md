# Contributing to first-tree

Thanks for helping improve `first-tree`.

This repository is in the middle of an intentional migration:

- the old single-package main branch is now reference material
- the active repo is a pnpm workspace
- the public CLI is being reshaped around `tree`, `github scan`, and `hub`
- `gardener` is moving out of the CLI and into a shipped skill

That means good contributions here do two things at once:

1. improve the current workspace
2. reduce ambiguity for the remaining port-back work

## Before You Change Anything

- Read [README.md](./README.md) for the public surface area.
- Read [docs/cli-restructure-migration.md](./docs/cli-restructure-migration.md)
  if your change touches command names, help output, or migration behavior.
- Read [docs/skill-topology.md](./docs/skill-topology.md) if your change touches
  shipped skills, onboarding docs, or the `tree skill` namespace.
- Read [docs/source-map.md](./docs/source-map.md) before moving code between
  `apps/cli` and `packages/auto`.
- If a change is large, cross-cutting, or proposal-shaping, open an issue or
  draft PR first so maintainers can align on the intended direction.

## Repository Boundaries

Keep changes in the correct package scope:

- Runtime/CLI behavior goes to `apps/*` (published packages).
- Shared internal logic belongs in `packages/*`.
- Documentation site content belongs in `apps/doc-website/`.

For VitePress documentation:

- Author content under `apps/doc-website/docs`.
- Update site behavior in `apps/doc-website/.vitepress/config.mts`.
- Keep the `srcDir` setting in that config aligned with actual file layout.

## Local Setup

Use the same baseline as CI:

- Node.js 22+
- pnpm 10+

Install dependencies from the repo root:

```bash
pnpm install
```

Use the doc site for content work:

```bash
pnpm --filter doc-website docs:dev
pnpm --filter doc-website docs:build
pnpm --filter doc-website docs:preview
```

## Validation

Run the standard checks before opening a PR:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

For documentation-only changes:

```bash
pnpm --filter doc-website docs:build
```

When your change includes documentation updates, run these too:

```bash
pnpm --filter doc-website docs:dev
pnpm --filter doc-website docs:preview
```

If you touch the published CLI package, also verify the built entry manually:

```bash
pnpm --filter first-tree build
node apps/cli/dist/index.js --help
```

If you touch both code and docs, run:

```bash
pnpm lint
pnpm typecheck
pnpm --filter first-tree build
pnpm --filter doc-website docs:build
```

## Documentation Contributions

`apps/doc-website` follows a VitePress-first workflow and should be treated as
code-like content:

- Add content files under `apps/doc-website/docs`.
- Keep file names descriptive and kebab-case, e.g. `deployment-guidelines.md`.
- Place a new page at a location that matches its destination route and intent.
- Do not move unrelated legacy docs.
- Add or update `frontmatter` only when needed.
  - `outline: deep` is recommended for long pages with multiple heading levels.
  - Prefer a single top-level `#` title and keep heading levels nested in
    order (`#`, `##`, `###`, ...).
- Use relative Markdown links and assets paths inside docs to reduce fragility.
- After adding, renaming, or removing pages, keep `apps/doc-website/.vitepress/config.mts`
  navigation updated:
  - `themeConfig.nav`
  - `themeConfig.sidebar`
- If the content touches CLI/behavior docs, ensure the corresponding command docs,
  examples, and migration notes stay synchronized.

A typical minimal doc page update flow is:

1. Edit or add content under `apps/doc-website/docs`.
2. Update route visibility in `apps/doc-website/.vitepress/config.mts`.
3. Run `pnpm --filter doc-website docs:build`.
4. For reviewable UI changes, run `pnpm --filter doc-website docs:dev` and confirm
   the page is reachable from nav/sidebar.

## Change Discipline

- Keep public command names aligned with the restructure proposal unless the PR
  explicitly updates that contract.
- If you change `first-tree github scan`, update the public docs and the
  binding-contract notes in the same PR.
- If you change `apps/cli` help output, update the CLI tests and any affected
  README or migration guide examples.
- If you port functionality back from the old main branch, prefer matching the
  proposal's new public paths instead of reviving deprecated names.
- Keep the root package thin. Product-facing CLI code belongs in `apps/cli/`;
  reusable runtime logic belongs in `packages/`.
- Keep code and docs in sync for behavior changes. If a command contract,
  workflow, or user-visible output changes, update docs in the same PR.
- For documentation-only changes, avoid changing unrelated code modules unless
  required for content accuracy.
- Keep docs page titles, links, and navigation deterministic; run docs build before
  opening PRs that touch `apps/doc-website`.

## Pull Requests

Helpful PRs for this repo usually include:

- the user-facing or maintainer-facing problem being solved
- the affected surface area (`tree`, `github scan`, `hub`, docs, packaging, or tests)
- the validation commands you ran
- any follow-up work that is still intentionally left out
- the documentation impact (`apps/doc-website`, affected routes, and any
  screenshots if UI/formatting changed)

## Where To Start Reading

- [README.md](./README.md) for the public entrypoint
- [docs/source-map.md](./docs/source-map.md) for the maintainer reading order
- [packages/auto/README.md](./packages/auto/README.md) for the current
  GitHub scan implementation
