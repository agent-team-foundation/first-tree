---
name: first-tree-read
description: Read the current repo's Context Tree before acting. Use when the user provides a task, topic, file path, feature name, bug, error, repo area, owner, or other signal and Codex needs to locate and read the relevant context files from the bound context repo. Always inspect `first-tree tree tree --help` in the context repo first, then use `first-tree tree tree` filtering options to select candidate files; read the selected file contents with the agent's native file-reading capability.
---

# First Tree Read

## Purpose

Read the Context Tree for the current repo before acting. This skill is
read-only: it uses `first-tree tree tree` to find relevant tree files, then
uses the agent's native file-reading capability to read their content and
summarize the constraints that matter for the user's task.

Use `first-tree-write` for tree writes from a source artifact. This
skill does not own broad drift audits; when the user asks whether the
tree is generally up to date, report that no shipped broad-audit skill
is available and ask for a specific source artifact or scope.

## Workflow

### 1. Inspect the reader command every time

Run the help command from inside the context repo before using any
`tree tree` selector:

```bash
cd "$CONTEXT_REPO"
first-tree tree tree --help
```

Treat this help output as the source of truth for flags and filtering modes.
Do not invent flags from memory. Note `first-tree tree tree` refreshes the
repo with `git pull --ff-only` before listing (use `--no-pull` to skip).

### 2. Build the read query from the user's signal

Extract concrete selectors from the request:

- repo, package, app, or service names
- file paths, directories, route names, command names, schema names, or config keys
- feature names, domain terms, error text, PR / issue titles, or owner names
- cross-domain hints such as auth, billing, CLI, daemon, context tree, web, server, client, or shared

Start broad enough to find the right domain, then narrow to the nodes that
matter. Prefer reading:

- root `NODE.md` and `AGENTS.md` when the command exposes them
- parent `NODE.md` files for the matched domain
- specific leaf files matched by the query
- `soft_links` targets from matched files when they affect the task
- `members/<id>/NODE.md` only when ownership or review scope matters

### 3. Use `first-tree tree tree` to select files

Use the filtering options shown by `first-tree tree tree --help` to list
candidate files. The exact flags may change; choose them from the fresh help
output.

Operational rules:

- Use `first-tree tree tree` for tree discovery and filtering instead of
  raw `find` / ad hoc grep when the command can identify the needed files.
- First list candidates, then read content only for the relevant files with
  the agent's native file-reading capability.
- If a query returns no results, widen once using parent domain terms and once
  using repo / package terms before concluding that no relevant context exists.
- Keep the read set focused. Do not dump the whole tree unless the user's task
  explicitly requires a workspace-wide read.
- If the command fails, report the failure, cwd, and attempted selector. Do not
  silently bypass the CLI filtering requirement.

### 4. Apply what was read

Before acting on the user's task, state the context files read when useful and
separate durable tree facts from your own inference.

If tree content conflicts with the user's instruction, follow the tree
constraint and surface the conflict. If the tree says nothing relevant, say so
briefly and proceed from repo evidence.

## Output Expectations

Keep the user-facing result concise:

- list the relevant context paths only when it helps traceability
- summarize the durable decisions, constraints, ownership, and cross-domain
  relationships that affect the task
- avoid restating every node; carry forward only what changes how you act

Never modify tree files with this skill.
