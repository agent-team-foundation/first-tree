# Tagging Protocol

Tags are the machine-readable collaboration layer between agents and humans
on GitHub. The daemon (`first-tree github scan`) and any agent it spawns
read and write the same set.

## The Four Tags

| Tag                 | Set when                                      | Set by                                               |
| ------------------- | --------------------------------------------- | ---------------------------------------------------- |
| `github-scan:new`   | Item just landed in the inbox                 | Daemon (initial state, also restored by auto-revert) |
| `github-scan:wip`   | Agent has started real work                   | Agent — set as soon as you commit to handling it     |
| `github-scan:human` | Agent decided a human must step in            | Agent — set before stopping work                     |
| `github-scan:done`  | Agent finished and the item is closed for now | Agent — set before stopping work                     |

## One Tag At A Time

Every notification carries **exactly one** `github-scan:*` label. When you
move from one state to another, remove the previous label in the same
operation:

```bash
# Move from new → wip
gh issue edit <number> --repo <owner>/<repo> \
  --remove-label "github-scan:new" \
  --add-label "github-scan:wip"

# Move from wip → done (or human)
gh pr edit <number> --repo <owner>/<repo> \
  --remove-label "github-scan:wip" \
  --add-label "github-scan:done"
```

If you cannot remove the previous label (insufficient permission, label
absent), proceed with the add — but log the inconsistency. Two
`github-scan:*` labels at once will confuse the daemon and humans.

## Lifecycle

```
              ┌────────────────────────────────────────────┐
              │                                            │
              ▼                                            │
        github-scan:new ──► github-scan:wip ──► github-scan:done
                                  │                      ▲
                                  │                      │ (rare; only if
                                  ▼                      │  the item later
                          github-scan:human ─────────────┘  resolves)
                                  │
                                  │ human comments >20 chars
                                  ▼
                          github-scan:new (auto-revert)
```

## Auto-Revert Of `github-scan:human`

The daemon watches every notification labelled `github-scan:human`. When a
human (anyone whose login is not the agent's identity login) posts a
comment longer than 20 characters, the daemon automatically:

1. removes `github-scan:human`
2. adds `github-scan:new`

Reactions alone do not trigger this — only comment bodies. Reviews count
as comments.

This means when you set `github-scan:human` and stop, the next human reply
pulls the item back into the queue automatically. You do not need to poll.

## Tag Hygiene Rules

- **Set `github-scan:wip` before any side-effect.** If the work fails
  before you reach a terminal state, leave `wip` so a human sees the
  in-progress mark instead of `new`.
- **Set the terminal tag before posting the final comment.** If you post
  a comment first, a fast-acting human auto-revert may race the label
  flip and confuse the daemon.
- **Do not invent new tags.** The four above are the contract. If you
  need a new state, escalate to the user — do not silently create
  `github-scan:waiting-on-ci` or similar.
- **Do not edit other agents' labels.** Only the agent that owns the
  current `github-scan:*` cycle should be flipping it.

## When You Cannot Set A Tag

If `gh` returns 403 (no permission to edit labels) or 422 (label does not
exist on the repo), include this in the GITHUB_SCAN_RESULT summary:

```
GITHUB_SCAN_RESULT: status=skipped route=human summary=cannot set github-scan:* labels — repo missing label or permission denied
```

The daemon will surface the skip to the user. Do not retry; do not write
a comment instead.
