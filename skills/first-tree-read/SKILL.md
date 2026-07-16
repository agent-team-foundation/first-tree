---
name: first-tree-read
description: Read the current repo's Context Tree before acting. Use when the user provides a task, topic, file path, feature name, bug, error, repo area, owner, or other signal and Codex needs to locate and read the relevant context files from the bound context repo. Do not use for a Cloud Context Reviewer wake-up or an explicit Context Tree PR review; `context-tree-review` exclusively owns that snapshot. Always inspect `first-tree tree tree --help` in the context repo first, then use `first-tree tree tree` filtering options to select candidate files; read the selected file contents with the agent's native file-reading capability.
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

Do not use this skill for a Cloud Context Reviewer wake-up or an explicit
request to review a Context Tree pull request. `context-tree-review` has
exclusive precedence there and reads only from its detached, validated PR-head
snapshot; running this workflow first would refresh and inspect the main tree
checkout instead.

## Authority Boundary

Apply the generated Context Tree Policy's content classes and drift-authority
rules before treating a file as current truth. Normal content is the canonical
decision/constraint source; non-normal classes have narrower authority and
should be labeled separately when they affect an answer.

Do not promote non-normal content into canonical tree facts. If normal content
requires non-normal material to be understood, report a tree hygiene concern.
If code and tree content conflict, follow the generated policy's code-vs-tree
drift rule.

## Workflow

### 1. Resolve the context repo

Find the workspace binding from the current working directory:

```bash
find_workspace_root() {
  local d=$(pwd)
  while [ "$d" != "/" ]; do
    if [ -f "$d/.first-tree/workspace.json" ]; then echo "$d"; return; fi
    d=$(dirname "$d")
  done
  return 1
}

WS=$(find_workspace_root) || { echo "No First Tree workspace at or above cwd"; exit 1; }
cat "$WS/.first-tree/workspace.json"
```

Resolve the context repo as `<workspaceRoot>/<manifest.tree>`. If the
manifest is missing or malformed, stop and report the binding gap — do
not guess a context repo.

If the manifest is present but the resolved path **does not exist on
disk**, the workspace is agent-managed and this is the agent's job to
materialise: follow the **Tree Location** block in your `AGENTS.md` /
`CLAUDE.md` briefing to clone the upstream tree repo into the resolved
path (the briefing carries the upstream URL, branch, and a ready
`git clone` command). Once the directory exists, continue below. (If the
path exists as a **symlink**, treat it as the legacy shared-pool layout —
remove only the symlink, then clone per the briefing.)

You do **not** need a separate `git pull` step before reading: the
`first-tree tree tree` command in step 2 runs `git pull --ff-only` on the
context repo for you (a built-in freshness guarantee), degrading to the
local copy with a warning if the remote is unreachable. Pass `--no-pull`
only when you deliberately want a stable snapshot or are working offline.

### 2. Inspect the reader command every time

Run the help command from inside the context repo before using any
`tree tree` selector:

```bash
cd "$CONTEXT_REPO"
first-tree tree tree --help
```

Treat this help output as the source of truth for flags and filtering modes.
Do not invent flags from memory. Note `first-tree tree tree` refreshes the
repo with `git pull --ff-only` before listing (use `--no-pull` to skip).

### 3. Build the read query from the user's signal

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
- member content only when ownership or review scope matters

### 4. Use `first-tree tree tree` to select files

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

### 5. Apply what was read

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
