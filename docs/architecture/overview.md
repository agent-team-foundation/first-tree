# Maintainer Architecture

Authoritative decision node: `first-tree-skill-cli/repo-architecture.md` in
the bound Context Tree.

This file is source-repo-local. It maps the tree's architectural decisions onto
the files maintainers edit in this repo.

## Three Products, One Maintenance Namespace

`first-tree` is an umbrella CLI that dispatches into three products:

- **`tree`** — Context Tree tooling (inspect / init / bind / verify / publish / upgrade / sync / ...)
- **`breeze`** — Proposal / inbox daemon with a GitHub notifications statusline
- **`gardener`** — Automated maintenance agent for tree sync PRs and source-repo review comments

It also exposes one maintenance namespace:

- **`skill`** — inspect, diagnose, and repair the four shipped skill payloads

The three products live under `src/products/<name>/` and share the same shape.
The single source of truth for the CLI namespace set is
`src/products/manifest.ts` — the umbrella CLI, version reporting, and skill
tooling read from there.

## Four Skills

The package ships four skill payloads under `skills/`:

- **`skills/first-tree/`** — the entry-point skill: methodology, references
  (whitepaper, principles, ownership, onboarding, source-workspace-installation,
  upgrade-contract), and routing to the three product skills
- **`skills/tree/`**, **`skills/breeze/`**, **`skills/gardener/`** — one-file
  operational handbooks (`SKILL.md` + `VERSION`) for each product CLI; no
  `references/` of their own

Each skill has tracked alias symlinks at `.agents/skills/<name>/` and
`.claude/skills/<name>/` so local agents discover every skill the package
ships.

## Local Responsibility Map

| Path | Local responsibility |
| --- | --- |
| `src/cli.ts` | Top-level umbrella dispatcher for `first-tree <namespace> <command>`; iterates the namespace manifest |
| `src/products/manifest.ts` | Single source of truth for the CLI namespace set; add a new namespace by adding one entry here |
| `src/products/tree/` | Tree product root (CLI dispatcher + `VERSION`) |
| `src/products/tree/engine/` | Tree business logic: `commands/`, `runtime/`, `rules/`, `validators/`, plus `bind.ts`, `init.ts`, `verify.ts`, `publish.ts`, `sync.ts`, `workspace.ts`, `upgrade.ts`, `inspect.ts`, etc. |
| `src/products/breeze/` | Breeze product: CLI dispatcher + `engine/` (commands, runtime, daemon, bridge, statusline) |
| `src/products/gardener/` | Gardener product: CLI dispatcher + `engine/` (commands, runtime, comment, respond) |
| `src/meta/skill-tools/` | Maintenance namespace: skill inventory, diagnosis, installation, and symlink repair |
| `skills/first-tree/` | Entry-point skill payload that ships verbatim to user repos |
| `skills/tree/`, `skills/breeze/`, `skills/gardener/` | Per-product operational skill payloads |
| `assets/tree/` | Runtime assets for the tree product, installed or refreshed by the CLI (templates, workflows, prompts, helpers, examples) |
| `assets/breeze/dashboard.html` | SSE dashboard served by the breeze daemon HTTP server |
| `tests/` | Repo-local validation surface |
| Root package files | Packaging, build, and shell entrypoints |

## Local Guardrails

- Keep `.agents/skills/<name>/` and `.claude/skills/<name>/` as alias
  symlinks; edit `skills/<name>/`, not the aliases.
- Product directories must share the same shape: `cli.ts` + `VERSION` at the
  root, business logic under `engine/` (`commands/`, `runtime/`, and domain
  subdirectories). Breeze uses `engine/daemon/`; tree uses `engine/rules/`
  and `engine/validators/`. Do not place business logic at the product root
  alongside `cli.ts`.
- Every CLI namespace must be listed in `src/products/manifest.ts` —
  `src/cli.ts` iterates the manifest, so a missing entry means the namespace is
  invisible to the umbrella.
- Keep source/workspace repos free of tree content; tree nodes belong in the
  bound Context Tree repo.
- Treat `source-repos.md` as generated output; tree-side truth still lives in
  `.first-tree/tree.json` and `.first-tree/bindings/`. Source-side truth
  lives in `.first-tree/source.json` and `.first-tree/local-tree.json`.
- When the binding schema or install contract changes, update the tree node,
  source docs, code, and tests together.
