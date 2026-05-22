# Tree Structure

First Tree uses a Git repo as a durable, reviewable context layer.

## Core Objects

- `source/workspace root` — the implementation root that consumes tree context
- `tree repo` — the Git repo that stores `NODE.md`, leaf nodes, members, and metadata
- `binding` — the metadata that links the source/workspace root to the tree repo

## Tree Files

- `NODE.md` at each directory level describes the domain and points to child domains or leaves
- leaf markdown files capture durable decisions, rationale, or constraints
- source/workspace roots carry First Tree binding metadata in managed blocks
  inside `AGENTS.md` / `CLAUDE.md`
- tree repos carry tree identity and managed code-repo registry metadata in
  managed blocks inside `AGENTS.md` / `CLAUDE.md`

## Ownership

- Each directory has a `NODE.md` with `owners`
- leaf files inherit domain ownership unless they intentionally narrow it
- `owners: [*]` means anyone may edit; otherwise owner review is expected

## Cross-Domain Links

- Use `soft_links` to point at related domains
- Follow `soft_links` before making cross-domain edits
- Prefer links over duplicating the same decision in multiple places
