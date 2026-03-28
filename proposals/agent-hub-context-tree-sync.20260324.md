---
title: "Agent Hub — Context Tree Agent Auto-Sync Design"
status: draft
owners: [baixiaohang]
soft_links:
  - proposals/agent-hub-overview.20260320.md
  - proposals/agent-hub-server-detailed-design.20260320.md
  - proposals/agent-adapter-design.20260323.md
  - members/NODE.md
---

# Context Tree Agent Auto-Sync Design

Agent Hub Server reads the Context Tree `members/` directory via GitHub GraphQL API and automatically creates/updates/suspends agents. Manual agent creation is removed — the Context Tree is the single source of truth for agent identity.

Relates to [agent-adapter-design §8.1](agent-adapter-design.20260323.md) ("Context Tree driven Agent creation").

---

## 1. Design Principles

| Principle | Description |
|---|---|
| **Context Tree is the source of truth** | Agent identity (id, displayName, type, role, domains) comes exclusively from `members/` directory. |
| **Server is a passive consumer** | Server reads the tree; it never writes back to the tree. |
| **Suspend, don't delete** | When a member disappears from the tree, the agent is suspended (not deleted). Admin confirms deletion manually. |
| **Optional, graceful degradation** | Context Tree sync is optional. If `contextTree` config or `GITHUB_TOKEN` is not set, sync is silently skipped and server starts normally. |
| **Token management stays manual** | Token create/revoke remains an Admin operation. No auto-generation or write-back. |

---

## 2. Data Mapping

Each member is a directory under `members/` containing a `NODE.md` with YAML frontmatter.

Example source (`members/bestony/NODE.md`):

```yaml
---
title: "bestony"
owners: [bestony]
type: human
role: "Engineer"
domains:
  - "system design"
  - "kael agent development"
---
```

Mapping to `agents` table:

| NODE.md field | agents column | Notes |
|---|---|---|
| Directory name (`bestony`) | `id` | Primary key. Must match `^[a-z0-9_-]+$`. |
| `title` | `displayName` | Display name across the system. |
| `type` | `type` | `human` / `personal_assistant` / `autonomous_agent`. |
| `role` | `metadata.role` | Stored in JSONB metadata. |
| `domains` | `metadata.domains` | Stored in JSONB metadata. |
| `owners` | `metadata.owners` | GitHub usernames. Stored in JSONB metadata. |
| — | `organizationId` | Always `"default"`. |
| — | `inboxId` | Auto-generated as `inbox_{id}`. |
| — | `status` | Set to `"active"` on creation. |

### 2.1 Required Frontmatter Fields

The sync process requires these fields in `NODE.md` frontmatter:

| Field | Required | Validation |
|---|---|---|
| `title` | Yes | Non-empty string |
| `type` | Yes | One of: `human`, `personal_assistant`, `autonomous_agent` |
| `owners` | Yes | Non-empty array of strings |
| `role` | No | String |
| `domains` | No | Array of strings |

A member directory missing `NODE.md` or with invalid required fields is skipped and reported as an error in the sync report.

---

## 3. Sync Mechanism

### 3.1 Data Source: GitHub GraphQL API

Server reads the Context Tree from a GitHub repository via GraphQL API (see [agent-hub-deployment-design §7](agent-hub-deployment-design.20260323.md)). A single GraphQL query fetches all member NODE.md contents regardless of member count:

```graphql
query($owner: String!, $name: String!, $expr: String!) {
  repository(owner: $owner, name: $name) {
    object(expression: $expr) {
      ... on Tree {
        entries {
          name
          type
          object {
            ... on Tree {
              entries {
                name
                object { ... on Blob { text } }
              }
            }
          }
        }
      }
    }
  }
}
```

Authentication uses `Authorization: Bearer ${GITHUB_TOKEN}`. HTTP client is native `fetch` — no `@octokit/rest` dependency.

### 3.2 Triggers

| Trigger | When | Description |
|---|---|---|
| **Startup** | Server boot | Sync on startup (non-blocking). If `contextTree` config is not set, skip silently. |
| **Periodic** | Every N seconds | Background interval. Default 60s, configurable via `contextTree.syncInterval`. |
| **Manual** | `POST /admin/agents/sync` | Admin-triggered on demand. Returns sync report. |

### 3.3 Sync Algorithm

```
syncAgents(config, db):
  // 1. Read tree via GitHub GraphQL API
  treeMembers = fetchMembersFromGitHub(config.contextTree.repo, config.contextTree.branch)
    → single GraphQL query to get all entries under members/
    → for each subdirectory with a valid NODE.md, parse YAML frontmatter
    → skip members/NODE.md itself (index file)
    → collect: { id (dirname), title, type, role, domains, owners }

  // 2. Read DB
  dbAgents = SELECT * FROM agents WHERE status != 'deleted'

  // 3. Build lookup maps
  treeSet = Set(treeMembers.map(m => m.id))
  dbMap   = Map(dbAgents.map(a => [a.id, a]))

  // 4. Diff & apply
  created  = []
  updated  = []
  suspended = []
  errors   = []

  // 4a. Create or update
  for member in treeMembers:
    existing = dbMap.get(member.id)
    if !existing:
      createAgent(db, member)  → created.push(member.id)
    else if needsUpdate(existing, member):
      updateAgentFromTree(db, member)  → updated.push(member.id)
      // If agent was suspended (by a previous sync) and reappears
      // in the tree, reactivate it
      if existing.status == 'suspended':
        reactivate  → updated.push(member.id)

  // 4b. Suspend orphans
  for agent in dbAgents:
    if !treeSet.has(agent.id) && agent.status == 'active':
      updateAgent(db, agent.id, { status: 'suspended' })
      // Suspend revokes all tokens (existing behavior)
      suspended.push(agent.id)

  return { created, updated, suspended, unchanged, errors }
```

### 3.4 Update Detection

An agent is updated when any of these fields differ between tree and DB:

| Field | Comparison |
|---|---|
| `displayName` | `member.title !== agent.displayName` |
| `type` | `member.type !== agent.type` |
| `metadata.role` | `member.role !== agent.metadata.role` |
| `metadata.domains` | Deep equality check |
| `metadata.owners` | Deep equality check |

### 3.5 Reactivation

If a member reappears in the tree after being removed (and the agent was suspended by sync, not yet manually deleted), the sync reactivates the agent:

- Set `status = 'active'`
- Update fields from tree
- **Tokens are NOT auto-restored** — Admin must create new tokens manually

### 3.6 Concurrency Safety

Multiple Server instances may run concurrently. Use **PostgreSQL advisory lock** to ensure only one instance runs sync at a time:

```sql
SELECT pg_try_advisory_lock(hashtext('agent-sync'))
```

- Lock acquired → proceed with sync
- Lock not acquired → skip this round (another instance is syncing)
- Lock released after sync completes (or on error)

### 3.7 Startup Behavior

On server startup:

1. Check if `contextTree` config block is present in `server.yaml` and `GITHUB_TOKEN` is available
2. If not configured → log info message, skip sync, server starts normally
3. If configured → run initial sync (non-blocking), register periodic sync interval

Context Tree sync is **optional**. Server starts and operates normally without it — agents can still be managed manually when sync is disabled.

---

## 4. Configuration

Configuration aligns with [agent-hub-deployment-design §4.3](agent-hub-deployment-design.20260323.md) and §7.3:

### 4.1 Server Config (`server.yaml`)

```yaml
# Optional — omit entire block to disable Context Tree sync
contextTree:
  repo: org/first-tree          # GitHub owner/repo
  branch: main                  # Branch to read from (default: main)
  syncInterval: 60              # Seconds between periodic syncs (default: 60, 0 = manual-only)
```

### 4.2 Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GITHUB_TOKEN` | No (needed for sync) | GitHub token for GraphQL API access. Without it, sync is silently skipped. |
| `CONTEXT_TREE_REPO` | No | Override `contextTree.repo` via env var. |

---

## 5. API Changes

### 5.1 Removed Endpoints

| Method | Path | Reason |
|---|---|---|
| `POST` | `/api/v1/admin/agents` | Agents are created by sync, not manually. |

### 5.2 Modified Endpoints

#### `PATCH /api/v1/admin/agents/:agentId`

Restricted to `status` changes only. displayName, type, and metadata are tree-managed.

**New request body schema:**

```typescript
// Before
z.object({
  displayName: z.string().max(200).nullish(),
  status: agentStatusSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});

// After
z.object({
  status: agentStatusSchema.optional(),
});
```

#### `DELETE /api/v1/admin/agents/:agentId`

**Retained.** Admin can manually delete agents (e.g., after sync suspends an orphaned agent). Behavior unchanged — soft delete + revoke tokens + clean up adapter bindings.

### 5.3 New Endpoints

#### `POST /api/v1/admin/agents/sync`

Trigger a manual sync. Returns the sync report.

**Response (200):**

```json
{
  "syncedAt": "2026-03-24T10:00:00.000Z",
  "repo": "org/first-tree",
  "summary": {
    "created": 2,
    "updated": 1,
    "suspended": 0,
    "unchanged": 5,
    "errors": 0
  },
  "created": ["new-agent-1", "new-agent-2"],
  "updated": ["bestony"],
  "suspended": [],
  "errors": []
}
```

#### `GET /api/v1/admin/agents/sync/status`

Returns the most recent sync result (stored in memory, not persisted).

**Response (200):**

```json
{
  "lastSync": {
    "syncedAt": "2026-03-24T10:00:00.000Z",
    "summary": { "created": 0, "updated": 0, "suspended": 0, "unchanged": 8, "errors": 0 },
    "errors": []
  },
  "nextSyncAt": "2026-03-24T10:01:00.000Z",
  "syncIntervalSeconds": 60
}
```

---

## 6. Shared Schema Changes

### 6.1 Updated

**`updateAgentSchema`** — restrict to status only:

```typescript
export const updateAgentSchema = z.object({
  status: agentStatusSchema.optional(),
});
```

### 6.2 New

**`syncReportSchema`** — sync result validation:

```typescript
export const syncReportSchema = z.object({
  syncedAt: z.string(),
  repo: z.string(),
  summary: z.object({
    created: z.number(),
    updated: z.number(),
    suspended: z.number(),
    unchanged: z.number(),
    errors: z.number(),
  }),
  created: z.array(z.string()),
  updated: z.array(z.string()),
  suspended: z.array(z.string()),
  errors: z.array(z.object({
    memberId: z.string(),
    error: z.string(),
  })),
});
export type SyncReport = z.infer<typeof syncReportSchema>;
```

**`memberNodeSchema`** — NODE.md frontmatter validation:

```typescript
export const memberNodeSchema = z.object({
  title: z.string().min(1),
  type: agentTypeSchema,
  owners: z.array(z.string()).min(1),
  role: z.string().optional(),
  domains: z.array(z.string()).optional(),
});
export type MemberNode = z.infer<typeof memberNodeSchema>;
```

---

## 7. Server Implementation

### 7.1 New Files

| File | Responsibility |
|---|---|
| `services/tree-reader.ts` | Fetch `members/` tree via GitHub GraphQL API, parse NODE.md YAML frontmatter, validate with `memberNodeSchema`, return list of `MemberNode`. |
| `services/agent-sync.ts` | Core sync logic: read tree → read DB → diff → create/update/suspend. Advisory lock management. Sync report generation. |
| `api/admin/agent-sync.ts` | HTTP routes: `POST /admin/agents/sync`, `GET /admin/agents/sync/status`. |

### 7.2 Modified Files

| File | Changes |
|---|---|
| `services/agent.ts` | `createAgent()` becomes internal-only (not exposed via route). Add `updateAgentFromTree()` for tree-driven updates (writes displayName, type, metadata). |
| `api/admin/agents.ts` | Remove `POST /` route. Keep `DELETE /:agentId`. |
| `app.ts` (or startup) | Check `contextTree` config, conditionally run initial sync, register periodic sync interval. |
| `config.ts` | `contextTree` is already defined as `optional()` in server config schema (see deployment design §4.3). |

### 7.3 Dependencies

| Package | Purpose |
|---|---|
| `gray-matter` | Parse YAML frontmatter from NODE.md content returned by GitHub API. Lightweight, widely used, zero-dep YAML parser included. |

No additional HTTP client dependency — uses native `fetch` for GitHub GraphQL API.

---

## 8. Web Changes

### 8.1 Agents List Page (`agents.tsx`)

| Change | Description |
|---|---|
| Remove "Add Agent" button and dialog | No manual creation. |
| Add "Sync Now" button | Calls `POST /admin/agents/sync`, shows result toast. |
| Add sync status bar | Shows last sync time, next sync time, and last sync summary (e.g., "8 agents synced, 0 errors"). |

### 8.2 Agent Detail Page (`agent-detail.tsx`)

| Change | Description |
|---|---|
| displayName field → read-only | Show value with "Managed by Context Tree" label. |
| type field → read-only | Show value with "Managed by Context Tree" label. |
| Add metadata display | Show `role` and `domains` as read-only badges/tags. |
| Keep status toggle | Admin can still suspend/activate agents. |
| Keep "Delete Agent" button | Admin can manually delete (e.g., orphaned agents after sync suspends them). |
| Keep token management | Unchanged. |
| Keep adapter bindings | Unchanged. |

### 8.3 New API Client Functions (`api/agents.ts`)

```typescript
// Remove
export async function createAgent(data: CreateAgent): Promise<Agent> { ... }

// Add
export async function triggerSync(): Promise<SyncReport> { ... }
export async function getSyncStatus(): Promise<SyncStatus> { ... }
```

---

## 9. Error Handling

| Scenario | Behavior |
|---|---|
| `contextTree` config not set | Sync silently skipped, server starts normally. |
| `GITHUB_TOKEN` not set | Sync silently skipped, server starts normally. Log info: "Context Tree sync disabled: GITHUB_TOKEN not configured". |
| GitHub API unreachable / auth failure | Log error, skip this sync round. Server continues running. Next periodic run retries. |
| `members/` tree not found in repo | Log error, skip sync. Report in sync status. |
| Individual NODE.md parse failure | Skip that member, include in `errors` array of sync report. Other members sync normally. |
| NODE.md missing required fields | Skip, report error: "{memberId}: missing required field '{field}'". |
| Directory name fails agent ID validation | Skip, report error: "{dirname}: invalid agent ID format". |
| Database error during sync | Abort sync, log error, report in sync status. Next periodic run retries. |
| Advisory lock not acquired | Skip this sync round. Log at debug level. |

---

## 10. Sync Lifecycle Example

```
Context Tree state:
  members/
  ├── liuchao-001/NODE.md    (human, "Liu Chao")
  ├── bestony/NODE.md        (human, "bestony")
  ├── serenakeyitan/NODE.md  (human, "serenakeyitan")
  └── yuezengwu/NODE.md      (human, "yuezengwu")

─── First sync (server startup) ───

  DB before: empty
  DB after:  4 agents created (active)
  Report:    created: [liuchao-001, bestony, serenakeyitan, yuezengwu]

─── Member added ───

  Tree adds: members/kael-agent/NODE.md (autonomous_agent)
  Next sync: created: [kael-agent]

─── Member removed ───

  Tree removes: members/serenakeyitan/
  Next sync: suspended: [serenakeyitan]
    → All tokens for serenakeyitan are revoked
    → Admin sees serenakeyitan as "suspended" in web UI
    → Admin can manually delete if confirmed

─── Member returns ───

  Tree re-adds: members/serenakeyitan/NODE.md
  Next sync: updated: [serenakeyitan]
    → status back to "active"
    → Admin must create new tokens (old ones were revoked)

─── Member info updated ───

  Tree changes: members/bestony/NODE.md title from "bestony" to "Bestony Chen"
  Next sync: updated: [bestony]
    → displayName updated to "Bestony Chen"
```

---

## 11. Out of Scope

| Item | Reason |
|---|---|
| Token auto-generation and write-back to tree | Keep token management manual for now. |
| Webhook-based sync | GitHub webhook could trigger immediate sync on push. Periodic polling is simpler for v0.2. |
| Local filesystem sync | Server reads via GitHub API only. Local file path mode may be added later for air-gapped environments. |
| Multi-tree support | Single `contextTree.repo`. Multi-org support is a separate initiative. |
