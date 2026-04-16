# Maintainer Architecture

Authoritative decision node: `first-tree-skill-cli/repo-architecture.md` in
the bound Context Tree.

This file is source-repo-local. It maps the tree's architectural decisions onto
the files maintainers edit in this repo.

## Local Responsibility Map

| Path | Local responsibility |
| --- | --- |
| `skills/tree/` | Canonical tree skill payload that ships verbatim to user repos (installed as `skills/first-tree/`) |
| `skills/breeze/` | Placeholder for the breeze skill payload (Phase 1+) |
| `assets/tree/` | Runtime assets for the tree product, installed or refreshed by the CLI |
| `assets/breeze/` | Placeholder for breeze runtime assets |
| `src/cli.ts` | Top-level umbrella dispatcher for `first-tree <product> <command>` |
| `src/products/tree/engine/` | Tree command behavior, binding logic, verification, publish, and sync orchestration |
| `src/products/tree/cli.ts` | Tree product dispatcher (lazy-loaded from the umbrella CLI) |
| `src/products/breeze/cli.ts` | Breeze product dispatcher stub (Phase 1+) |
| `tests/` | Repo-local validation surface |
| Root package files | Packaging, build, and shell entrypoints |

## Local Guardrails

- Keep `.agents/skills/first-tree/` and `.claude/skills/first-tree/` as alias
  symlinks; edit `skills/tree/`, not the aliases.
- Keep source/workspace repos free of tree content; tree nodes belong in the
  bound Context Tree repo.
- Treat `source-repos.md` as generated output; tree-side truth still lives in
  `.first-tree/tree.json` and `.first-tree/bindings/`.
- When the binding schema or install contract changes, update the tree node,
  source docs, code, and tests together.
