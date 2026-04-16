# Thin CLI Shell

Authoritative decision node: `first-tree-skill-cli/thin-cli-shell.md` in the
bound Context Tree.

Use this local reference when changing `src/cli.ts`, the product dispatchers in
`src/products/*/cli.ts`, or the tree command adapters in
`src/products/tree/engine/commands/`.

## Shell Responsibilities

The top-level shell (`src/cli.ts`) should:

- parse `first-tree <product> <command>`
- expose help and version (CLI + per-product VERSION)
- handle `--skip-version-check`
- lazy-load and dispatch into `src/products/<product>/cli.js`
- stay thin — never statically import another product

Each product dispatcher (currently `tree/cli.ts`; `breeze/cli.ts` is a stub)
owns its own USAGE and dispatches into its engine's command adapters.

## Current CLI Surface

```
first-tree tree <command>
```

Tree commands:

- `inspect`
- `init`
- `bind`
- `workspace`
- `publish`
- `verify`
- `upgrade`
- `sync`
- `review`
- `generate-codeowners`
- `invite`
- `join`
- `inject-context`
- `help`

```
first-tree breeze <command>
```

Breeze is a Phase 0 stub and exits with a not-implemented error.

## Local Touchpoints

- `src/cli.ts` — umbrella usage text, global flags, and product dispatch
- `src/products/tree/cli.ts` — tree product USAGE and command dispatch
- `src/products/breeze/cli.ts` — breeze stub dispatcher
- `src/products/tree/engine/commands/*.ts` — thin tree command adapters
- `tests/thin-cli.test.ts` — direct CLI smoke coverage
- `tests/cli-e2e.test.ts` — end-to-end command workflow coverage

## Rules For Shell Changes

- Keep onboarding semantics in the skill references and tree nodes, not only in
  `src/cli.ts`.
- If command behavior changes, update the relevant tree node and shipped
  reference docs before relying on the code to explain it.
- Keep root prose short; detailed implementation notes belong here, while
  decision-grade operational knowledge belongs in the tree.
