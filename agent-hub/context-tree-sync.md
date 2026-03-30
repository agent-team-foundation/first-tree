---
title: "Context Tree Agent Sync"
owners: [baixiaohang]
soft_links: [/members]
---

# Context Tree Agent Sync

Agent Hub Server reads the Context Tree `members/` directory via GitHub GraphQL API and automatically creates, updates, and suspends agents. The Context Tree is the single source of truth for agent identity.

---

## Principles

| Principle | Description |
|-----------|-------------|
| **Context Tree is the source of truth** | Agent identity (id, displayName, type, role, domains) comes exclusively from `members/` directory. |
| **Server is a passive consumer** | Server reads the tree; it never writes back. |
| **Suspend, don't delete** | When a member disappears from the tree, the agent is suspended (not deleted). Admin confirms deletion manually. |
| **Optional, graceful degradation** | If `contextTree` config or `FIRST_TREE_HUB_GITHUB_TOKEN` is not set, sync is silently skipped and server starts normally. |
| **Token management stays manual** | Token create/revoke remains an Admin operation. No auto-generation or write-back. |

---

## Data Mapping

Each member is a directory under `members/` containing a `NODE.md` with YAML frontmatter:

```yaml
# members/bestony/NODE.md
---
title: "bestony"
type: human
owners: [bestony]
role: "Engineer"
domains: ["system design", "kael agent development"]
---
```

| NODE.md field | agents column | Notes |
|---------------|---------------|-------|
| Directory name | `id` | Primary key. Must match `^[a-z0-9_-]+$`. |
| `title` | `displayName` | Display name across the system. |
| `type` | `type` | `human` / `personal_assistant` / `autonomous_agent`. |
| `role` | `metadata.role` | Stored in JSONB metadata. |
| `domains` | `metadata.domains` | Stored in JSONB metadata. |
| `owners` | `metadata.owners` | GitHub usernames. |

---

## Sync Mechanism

### Triggers

| Trigger | When | Description |
|---------|------|-------------|
| **Startup** | Server boot | Non-blocking initial sync. Skipped silently if not configured. |
| **Periodic** | Every N seconds | Background interval (default 60s, configurable). |
| **Manual** | `POST /admin/agents/sync` | Admin-triggered. Returns sync report. |
| **Webhook** | `POST /webhooks/github` | GitHub push event triggers immediate sync. |

### Algorithm

1. **Read tree** — Single GraphQL query fetches all entries under `members/`. Parse YAML frontmatter from each `NODE.md`.
2. **Read DB** — All agents with `status != 'deleted'`.
3. **Diff & apply**:
   - In tree but not in DB → **create** agent.
   - In tree and in DB but fields differ → **update** agent. If status was `suspended`, reactivate.
   - In DB but not in tree → **suspend** agent (revoke all tokens).
4. **Report** — Return `{ created, updated, suspended, unchanged, errors }`.

### Concurrency Safety

PostgreSQL advisory lock ensures only one instance syncs at a time. Lock not acquired → skip this round. No contention, no double processing.

---

## Lifecycle Example

```
── First sync (server startup) ──
  Tree: [liuchao-001, bestony, yuezengwu]
  DB: empty
  Result: created 3 agents

── Member added ──
  Tree adds: kael-agent (autonomous_agent)
  Result: created [kael-agent]

── Member removed ──
  Tree removes: serenakeyitan
  Result: suspended [serenakeyitan], all tokens revoked
  Admin sees "suspended" in Web UI, can manually delete

── Member returns ──
  Tree re-adds: serenakeyitan
  Result: reactivated [serenakeyitan]
  Admin must create new tokens (old ones were revoked)
```

---

## Configuration

```yaml
# server.yaml — optional, omit entire block to disable sync
contextTree:
  repo: org/first-tree          # GitHub owner/repo
  branch: main                  # Branch to read (default: main)
  syncInterval: 60              # Seconds between periodic syncs
```

Environment: `FIRST_TREE_HUB_GITHUB_TOKEN` (GitHub token for API access), `FIRST_TREE_HUB_CONTEXT_TREE_REPO` (override repo).

Without these, sync is silently disabled. Server operates normally — agents can still be managed manually.
