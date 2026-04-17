# Thin CLI Shell

Authoritative decision node: `first-tree-skill-cli/thin-cli-shell.md` in the
bound Context Tree.

Use this local reference when changing `src/cli.ts`, the namespace dispatchers in
`src/products/*/cli.ts`, or the tree command adapters in
`src/products/tree/engine/commands/`.

## Shell Responsibilities

The top-level shell (`src/cli.ts`) should:

- parse `first-tree <namespace> <command>`
- expose help and version (CLI + per-namespace VERSION)
- handle `--skip-version-check`
- lazy-load and dispatch into `src/products/<namespace>/cli.js`
- stay thin — never statically import another namespace

Each namespace dispatcher owns its own USAGE and dispatches into its engine's
command adapters. The primary products are `tree`, `breeze`, and `gardener`;
`skill` is the maintenance namespace for shipped skill health and repair.

## Current CLI Surface

Primary product namespaces:

- `first-tree tree <command>`
- `first-tree breeze <command>`
- `first-tree gardener <command>`

Maintenance namespace:

- `first-tree skill <command>`

## Local Touchpoints

- `src/cli.ts` — umbrella usage text, global flags, and namespace dispatch
- `src/products/tree/cli.ts` — tree product USAGE and command dispatch
- `src/products/breeze/cli.ts` — breeze product dispatcher
- `src/products/gardener/cli.ts` — gardener product dispatcher
- `src/meta/skill-tools/cli.ts` — maintenance-namespace dispatcher for shipped skill health
- `src/products/tree/engine/commands/*.ts` — thin tree command adapters
- `tests/e2e/thin-cli.test.ts` — direct CLI smoke coverage
- `tests/e2e/cli-e2e.test.ts` — end-to-end command workflow coverage

## Rules For Shell Changes

- Keep onboarding semantics in the skill references and tree nodes, not only in
  `src/cli.ts`.
- If command behavior changes, update the relevant tree node and shipped
  reference docs before relying on the code to explain it.
- Keep root prose short; detailed implementation notes belong here, while
  decision-grade operational knowledge belongs in the tree.
