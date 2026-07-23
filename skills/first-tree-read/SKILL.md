---
name: first-tree-read
version: 0.3.0
description: Read the current repo's Context Tree before acting. Use when the user provides a task, topic, file path, feature name, bug, error, repo area, owner, or other signal and Codex needs to locate and read the relevant context files. Supports GitHub and GitLab explicit-Team BYO activation with one online authority check, one strict fetch, and one exact task snapshot, while preserving managed-workspace compatibility. Do not use for a Context Tree PR/MR review or an explicit broad audit of stored tree content; `context-tree-review` owns trusted provider-scoped review snapshots and `context-tree-audit` owns audit snapshots.
---

# First Tree Read

## Purpose

Read the Context Tree for the current repo before acting. This skill is
read-only: it uses `first-tree tree tree` to find relevant tree files, then
uses the agent's native file-reading capability to read their content and
summarize the constraints that matter for the user's task. A BYO task first
activates one exact-commit snapshot; all selectors, soft-link traversal, and
file reads for that task stay inside it.

Use `first-tree-write` for tree writes from a source artifact. An explicit
request to audit stored normal content on the default branch belongs to
`context-tree-audit`; do not start this task-scoped read workflow first.

Do not use this skill for a Cloud Context Reviewer wake-up or an explicit
request to review a Context Tree PR/MR. `context-tree-review` has exclusive
precedence for its supported GitHub PR or GitLab MR path and reads only from its detached,
validated PR-head snapshot; running this workflow first would refresh and
inspect the main tree checkout instead.

Do not use this skill for an explicit broad audit of the whole tree, a domain,
or selected stored normal paths. `context-tree-audit` has exclusive precedence
and owns the stable default-branch snapshot, validate-first discovery, and
finding routing.

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

### 1. Choose the activation path

Use the **BYO task snapshot** path only when the task handoff or user input
names an explicit First Tree Team id. The Team id is required task input: do
not infer it from a Web selection, `/me` default, cached role, prior task, or
account-global current state. If a BYO Read is requested without that explicit
Team id, stop before reading Tree content and request it.

Otherwise retain the **managed workspace** path below. A workspace manifest is
the managed compatibility anchor; its presence is not a substitute for an
explicit Team in the BYO path.

### 2A. Activate one BYO task snapshot

Choose a new task-owned directory that does not already exist, then run exactly
one activation:

```bash
first-tree tree read --help
byo_read_root="$(mktemp -d)"
first-tree --json tree read --team "<team-id>" --snapshot "$byo_read_root/context-tree"
```

The command performs the fixed sequence: selected-Team active-membership plus
provider-aware current-binding check through the Server, one strict Git fetch
using only the Agent host's local git credential, exact commit
resolution, then an atomic detached snapshot. Its success receipt reports the
Team, binding repository and branch, exact commit, and absolute snapshot path.
Treat that receipt as the task's read identity.

Authority, binding, fetch, commit, or snapshot failure is fail-closed. Do not
read another checkout, retry against cached content, use a mutable branch, or
fall back to a managed workspace clone. Returned errors identify the failed
stage without exposing credentials. A private GitLab tree remains readable
here when the host identity has access; Cloud Web Context anonymous-read
availability is unrelated and never supplies or stores a GitLab credential.

Run hierarchy help from inside the activated snapshot before any selector:

```bash
cd "$byo_read_root/context-tree"
first-tree tree tree --help
```

Then use `first-tree tree tree --no-pull` for every hierarchy selector. The
snapshot marker also makes the hierarchy command suppress refresh, but the
flag keeps the task's no-network intent explicit. Read Markdown files with the
agent's native file-reading capability only from the receipt's snapshot path.
Resolve soft-links against that same root. Do not run another Server request,
fetch, pull, clone, or activation for the rest of the task.

Remote branch or Team binding movement does not change the active task. A new
task creates a new directory and performs a new activation so current
membership, binding, and commit are visible. Never reuse a snapshot across
Teams or tasks.

Continue at **Build the read query** below, using the activated snapshot as the
context repo.

### 2B. Resolve the managed workspace context repo

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

### 3. Inspect the managed reader command every time

Run the help command from inside the context repo before using any
`tree tree` selector:

```bash
cd "$CONTEXT_REPO"
first-tree tree tree --help
```

Treat this help output as the source of truth for flags and filtering modes.
Do not invent flags from memory. Note `first-tree tree tree` refreshes the
repo with `git pull --ff-only` before listing (use `--no-pull` to skip).

### 4. Build the read query from the user's signal

Extract concrete selectors from the request:

- repo, package, app, or service names
- file paths, directories, route names, command names, schema names, or config keys
- feature names, domain terms, error text, PR/MR or issue titles, or owner names
- cross-domain hints such as auth, billing, CLI, daemon, context tree, web, server, client, or shared

Start broad enough to find the right domain, then narrow to the nodes that
matter. Prefer reading:

- root `NODE.md` and `AGENTS.md` when the command exposes them
- parent `NODE.md` files for the matched domain
- specific leaf files matched by the query
- `soft_links` targets from matched files when they affect the task
- member content only when ownership or review scope matters

### 5. Use `first-tree tree tree` to select files

Use the filtering options shown by `first-tree tree tree --help` to list
candidate files. The exact flags may change; choose them from the fresh help
output.

Operational rules:

- Use `first-tree tree tree` for tree discovery and filtering instead of
  raw `find` / ad hoc grep when the command can identify the needed files.
- For a BYO task, include `--no-pull` on every selector and keep every selected
  path inside the activated snapshot. For a managed workspace, retain the
  command's existing pull-before-selector behavior.
- First list candidates, then read content only for the relevant files with
  the agent's native file-reading capability.
- If a query returns no results, widen once using parent domain terms and once
  using repo / package terms before concluding that no relevant context exists.
- Keep the read set focused. Do not dump the whole tree unless the user's task
  explicitly requires a workspace-wide read.
- If the command fails, report the failure, cwd, and attempted selector. Do not
  silently bypass the CLI filtering requirement.

### 6. Apply what was read

Before acting on the user's task, state the context files read when useful and
separate durable tree facts from your own inference.

If tree content conflicts with the user's instruction, follow the tree
constraint and surface the conflict. If the tree says nothing relevant, say so
briefly and proceed from repo evidence.

### 7. Record material decision influence

Attach a small `contextDecision` receipt only when all of these conditions hold:

1. The agent read a normal-content passage containing a current decision,
   constraint, rationale, or cross-domain relationship. Opening a file is not
   enough.
2. The passage was relevant to a concrete design, implementation, review, or
   debugging choice in the current task.
3. The read happened before the choice was made or executed.
4. The final visible message shows how the passage confirmed, constrained,
   redirected, or conflicted with that choice.

Do not attach a receipt for root or domain files used only as navigation,
`AGENTS.md`, skill or workflow instructions, pure ownership routing,
archive/proposal/supporting material alone, a Tree mention without decision
influence, or a task for which the Tree had no relevant decision-bearing
content. Do not emit `effect: none`.

When the task ends with a visible First Tree `chat send` that contains the
affected choice, add one receipt under the top-level `contextDecision` metadata
key on that same command. If Tree context exposes an unresolved conflict and
the task correctly ends with a blocking `chat ask`, attach the receipt to that
same ask instead. `chat send` and `chat ask` merge recipient mentions,
attachments, and body-origin metadata; supply only the new
`contextDecision` key. For example, pass the JSON below through
`--metadata '<json>'` on the same command that sends the final body. Do not send
a separate receipt message, put the receipt only in prose, or reconstruct other
metadata:

```json
{
  "contextDecision": {
    "version": 1,
    "effect": "constrained",
    "summary": "The existing organization-isolation constraint ruled out a global shared index.",
    "evidence": [
      {
        "repoUrl": "https://github.com/example/context-tree",
        "commit": "0123456789abcdef0123456789abcdef01234567",
        "nodePath": "system/cloud/team/tenancy-and-identity.md",
        "heading": "Organization isolation"
      }
    ]
  }
}
```

Use exactly one effect. Choose the first matching category in this precedence
order so periodic reports remain comparable:

1. `conflicted` — exposed a conflict that still requires resolution or
   escalation;
2. `redirected` — changed the intended approach;
3. `constrained` — ruled out an option or narrowed the acceptable solution or
   implementation boundary;
4. `confirmed` — removed material uncertainty and justified keeping the choice
   without changing its boundary.

Keep `summary` to one concrete sentence. Cite at most three Tree-root-relative
normal node paths that jointly influenced the same choice. `heading` is
optional; omit it when the relevant heading cannot be named reliably.

Every evidence row must identify the repository and exact commit that supplied
the passage. Store `repoUrl` as the credential-free binding repository exactly
as the Server activation receipt or managed workspace briefing declares it;
never substitute a local transport URL. Report consumers must compare this
field through First Tree's canonical repository identity rather than raw string
equality. Never persist a credential-bearing remote URL.

For a BYO task, use the activation receipt's binding repository and commit. Its
detached snapshot is already exact and remote-backed. For a managed workspace,
after the last hierarchy selector and before reading a candidate passage:

1. resolve the current branch's upstream remote-tracking ref and the fetch
   remote that owns it;
2. require that fetch remote's URL to be canonically equal to the binding
   repository declared by the workspace briefing;
3. record `git rev-parse HEAD`;
4. read the candidate normal-content files;
5. require HEAD to remain unchanged;
6. require every cited path to exist in that commit and have no staged or
   unstaged difference; and
7. require the commit to be reachable from that same upstream remote-tracking
   ref produced by the refresh.

If another pull or process moves HEAD during those steps, re-read from a new
stable commit before attributing influence. If the branch has no unambiguous
upstream, its owning fetch remote is missing, or the canonical repository
identities do not match, do not attribute the briefing's `repoUrl`. If
repository, commit, remote reachability, or path identity cannot be established
safely, omit the evidence row and do not attach the receipt when no valid
evidence remains.

The receipt is the agent's durable, reviewable attribution. It is not
server-verified proof of causality, and the final prose must not claim that it
is.

## Output Expectations

Keep the user-facing result concise:

- list the relevant context paths only when it helps traceability
- summarize the durable decisions, constraints, ownership, and cross-domain
  relationships that affect the task
- for BYO Read, report the selected Team, binding, and exact commit when it
  helps the user verify which task snapshot governed the answer
- when the strict decision-influence test passes, attach the receipt to the
  same final First Tree `chat send`, or to the same blocking `chat ask` for an
  unresolved conflict, instead of adding receipt prose or another message
- avoid restating every node; carry forward only what changes how you act

Never modify tree files with this skill.
