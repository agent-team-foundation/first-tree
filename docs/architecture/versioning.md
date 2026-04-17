# Versioning

`first-tree` ships several things that are independently versioned on purpose. This doc explains what each version means, when to bump which one, and why we don't try to collapse them into a single SemVer stream.

## The four version families

| Family | Files | Example | What it represents |
|--------|-------|---------|--------------------|
| **npm package** | `package.json` `version` field | `first-tree@0.2.6` | Released artifact. What `npm install -g first-tree` pins. Consumer-facing. |
| **Product** | `src/products/<name>/VERSION` | `tree=0.2.6`, `breeze=0.1.0`, `gardener=0.1.0` | The public surface of a single product CLI. Bumps on command-shape or behavior changes users may depend on. |
| **Skill payload** | `skills/<name>/VERSION` | `skills/tree/VERSION = 0.2` | The operational handbook an agent reads. Bumps when the user-facing guidance changes in a way existing installations should pick up. |
| **Runtime asset** | `assets/<name>/VERSION` | `assets/tree/VERSION = 0.2.6` | The asset bundle installed into user repos (templates, workflows, helpers). Bumps whenever installed content changes — this is what `first-tree tree upgrade` diffs against. |

Meta (non-product) commands also carry their own VERSION (e.g. `src/meta/skill-tools/VERSION = 0.2.6`). It follows the same rules as a product VERSION but isn't reported by `first-tree --version` (which iterates `PRODUCTS`, not meta).

## Why they are independent

Each family has a different audience and a different "breaking change" trigger:

- **npm package** changes when we cut a release — it encodes the whole bundle.
- **Product** changes when a single CLI's surface changes. Bumping gardener should not force a breeze release note.
- **Skill payload** changes when the agent-facing handbook changes. Users re-install skills via `first-tree tree upgrade`; the VERSION is how that upgrade knows something moved.
- **Runtime asset** changes when the files we install into user repos change. This version is the contract for in-place upgrades of user checkouts.

Collapsing these would either over-trigger upgrades (a breeze-only fix bumping every user's tree assets) or under-trigger them (a silent asset change invisible to `upgrade`).

## When to bump what

| Change type | Bump |
|-------------|------|
| Release a new npm version | `package.json` `version` |
| Add / change a `first-tree tree` subcommand | `src/products/tree/VERSION` |
| Add / change a `first-tree breeze` subcommand | `src/products/breeze/VERSION` |
| Add / change a `first-tree gardener` subcommand | `src/products/gardener/VERSION` |
| Edit `skills/first-tree/SKILL.md` or any shared reference | `skills/first-tree/VERSION` |
| Edit `skills/tree/SKILL.md` | `skills/tree/VERSION` |
| Edit a runtime template / workflow under `assets/tree/` | `assets/tree/VERSION` |
| Change the SSE dashboard HTML under `assets/breeze/` | *(none today — breeze assets are unversioned; bump if introducing VERSION)* |
| Change `first-tree skill list/doctor/link` behavior | `src/meta/skill-tools/VERSION` |

## How versions are read

- `first-tree --version` iterates `PRODUCTS` in [`src/products/manifest.ts`](../../src/products/manifest.ts) and prints one line per product via `readProductVersion`.
- Each dispatcher's `--version` reads its own VERSION via [`src/shared/version.ts`](../../src/shared/version.ts) (`readOwnVersion(import.meta.url, sourceRelativeDir)`).
- The umbrella CLI version comes from `package.json` via `readPackageVersion(import.meta.url, "first-tree")`.
- The installer reads `skills/<name>/VERSION` and `assets/<name>/VERSION` to decide whether to overwrite files during `first-tree tree init/upgrade`.

## Practical rules

- Never bump a version "just to be consistent". Each family changes on its own cadence.
- Bumping a skill VERSION without bumping its product VERSION is common — handbook edits rarely imply CLI behavior changes.
- Bumping an asset VERSION without bumping a skill or product is also common — a template-only change.
- The npm package version should be bumped last, after all other files that changed in the release are bumped, so release notes can refer to them.
