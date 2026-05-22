# Agent Templates (Step 5)

`tree init` writes two default templates into the tree at
`.first-tree/agent-templates/`:

- `developer.yaml` — handles code-related PRs and issues
- `code-reviewer.yaml` — focuses on PR review

These are the bodies the GitHub Scan daemon (and any future Hub daemon) reads
when spawning a per-task agent. They are not skill payloads; they are agent
_instances_.

## Schema

```yaml
name: developer # template id; matches the file name
prompt: | # system prompt (multi-line)
  Default First Tree developer agent.
  Use First Tree context before changing cross-repo decisions.
skills: # list of skill paths to load
  - .agents/skills/first-tree
  - .agents/skills/first-tree-sync
  - .agents/skills/first-tree-write
  - .agents/skills/first-tree-github-scan
runtime: codex # claude-code | codex | other
workspace:
  kind: worktree # worktree | persistent | container
env: {} # extra env to inject
auth:
  github:
    provider: env # env | secret-store
    variable: GITHUB_TOKEN
mcp: [] # optional MCP server connections
```

## What To Ask The User

Ask one question per role:

- "Do you want a developer agent?" — keep `developer.yaml` if yes; delete if no.
- "Do you want a code-reviewer agent?" — same.
- "Do you want a designer / QA / other custom agent?" — if yes, write a new
  YAML file using `developer.yaml` as the schema reference.

Do not ask the user to fill in every field. Defaults are fine for first-time
setup; the user can edit the template later.

## Editing Existing Templates

If the user wants to change the system prompt or skill set:

1. Edit the YAML file directly. Keep the field order from the schema.
2. Validate by reading the file back — there is no `tree validate-templates`
   command yet; YAML parse errors will surface only when the daemon spawns
   the agent.
3. Commit the change to the tree repo. Templates are owned by the tree, not
   the source repos.

## Adding A New Role

Pick a one-word role id. Create `.first-tree/agent-templates/<role>.yaml`
with the schema above. Reference the right skills for that role:

- code-related work → keep `first-tree`, `first-tree-sync`, `first-tree-write`,
  `first-tree-github-scan`.
- read-only triage → drop `first-tree-write`.
- pure code review → drop `first-tree-write` and `first-tree-sync`; keep
  `first-tree` and `first-tree-github-scan`.

Do not invent skills that do not exist on disk under
`.agents/skills/<name>/`. The daemon resolves these paths verbatim and will
fail to start the agent if any path is missing.

## What This Step Does NOT Do

- It does not start an agent. The daemon spawns agents when notifications
  arrive.
- It does not validate the YAML. If you want a smoke test, ask the user to
  run a `github scan` poll once the daemon is up.
- It does not register the templates anywhere. The daemon discovers them by
  reading `.first-tree/agent-templates/` at dispatch time.
