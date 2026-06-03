# Resources — per-type add/edit editors (Task 2)

Status: **DRAFT — awaiting confirmation before implementation.**
Branch: `feat/resources-typed-editors`, stacked on `feat/settings-ia-resources` (PR #802). Rebase onto `main` after #802 merges.

## Goal

Replace the single type-morphing create dialog on `/settings/resources` with **per-type editors behind one discoverable, type-first entry**, and **implement edit** (currently the page only supports create + retire).

## Why (evidence)

The four resource payloads diverge enough that one shared modal is both lossy today and a maintenance trap as they grow:

| Type | Schema fields | Today's dialog collects | Missing today |
|---|---|---|---|
| repo | `url`, `defaultBranch?` | url | defaultBranch |
| prompt | `body`(≤32KB), `description?` | body, description | — |
| skill | `name`, `namespace?`, `description`, `body`(≤64KB), `metadata{}` | name, description, body | namespace, metadata |
| mcp/stdio | `name`, `command`, `args[]` | command | args |
| mcp/http·sse | `name`, `url`, `headers{}` | url | headers |

Two of the four (`prompt`, `skill`) carry 32–64KB markdown bodies that want a real editor, not a modal field. `repo` is a one-liner; `mcp` is a structured config. Different editing weights → different surfaces.

## Proposed UX

**Entry (single, type-first):** keep one "Add resource" affordance, but make it a menu → Repo / Prompt / Skill / MCP. Avoids 4 scattered buttons; keeps "where do I add things" obvious. (Linear/Notion "New …" pattern.)

**Editors:**
- **repo** → modal. Fields: name, Repository URL, Default branch (optional), default-mode.
- **mcp** → modal. Fields: name, Transport (Select); stdio → command + args (repeatable rows); http/sse → url + headers (repeatable key/value rows); default-mode.
- **prompt** → drawer (full-height) OR dedicated route. Fields: name, description, **body** (large markdown editor), default-mode.
- **skill** → drawer/route. Fields: name, namespace (optional), description, **body** (large editor), metadata (key/value rows), default-mode.

**Edit:** same editors, prefilled, opened from a row action (edit icon / row click). Wires `updateResource` (`updateTeamResourceSchema`: name / defaultEnabled / status / payload). Retire stays.

**Shared chrome:** the name + default-mode field set and the `SelectField`/`Field` helpers from PR #802 are reused across all editors (no duplication of the common rows).

## Open decisions (confirm before building)

1. **prompt/skill surface:** full-height right **drawer** (stays in Settings context, my lean) vs **dedicated route** `/settings/resources/:id`. Drawer is lighter; route is better if bodies get very large / need deep-linking.
2. **Include edit in this task?** Strongly recommended — per-type editors pay off most when they serve create+edit. (Confirm yes.)
3. **MCP env vars / stdio `env`:** schema currently has `args` for stdio and `headers` for http/sse, no `env`. Confirm we only surface what the schema supports (no scope creep into new payload fields).
4. **Type-first menu vs section "+":** menu on the page header (my lean) vs a "+ Add" on each type Section. Menu keeps one anchor.

## Scope

- New components under `components/ui` only if a primitive is missing (e.g. a repeatable key/value rows control — check first, build with cva+cn if absent).
- Per-type editor components under `pages/settings/resources/` (split the current single file).
- Wire `updateResource`; add edit affordance to list rows.
- Tests: dom tests per editor (create + edit + validation of the newly-surfaced fields); update `/preview/resources` to exercise an editor open state.

## Acceptance criteria

- Each type has a purpose-built create form with **all** schema fields (incl. defaultBranch / args / headers / namespace / metadata).
- Edit works for every type (prefilled, round-trips through `updateResource`).
- Single discoverable entry; no irrelevant fields shown for a given type.
- Member read-only preserved; admin-only mutations preserved.
- DESIGN.md compliant (tokens + `ui/` primitives); `pnpm check` + `pnpm typecheck` + web tests green.

## Dependency / sequencing

Stacked on PR #802. Do not merge before #802. After #802 merges, rebase this branch onto `main`.
