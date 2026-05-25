# Chat-First Workspace Product Design

## Status

v2 — incorporates the technical review on PR #224. This revision is normative;
implementation MUST follow the data model, API contract, and invariants in
the main body. Implementation hints (specific SQL forms, file references,
realtime channel names) live in the appendix and may evolve.

Related issues:

- agent-team-foundation/first-tree-all#99
- agent-team-foundation/first-tree-all#103

---

## Summary

First Tree Hub Workspace moves from an agent-centric roster to a chat-first
collaboration surface.

The left rail contains conversations only. Agents and humans are selected
from the composer through one lightweight target picker. A new chat is not
configured in a modal and does not require a name. The user selects one or
more targets, writes the first message, and the system creates the right
chat:

- one target creates a new direct chat;
- multiple targets create a group chat;
- group titles are generated from participant names.

Chat mention notifications appear as red dots on conversation rows. System-
level events stay in the notification bell.

`agent_chat_sessions` keeps its responsibilities (runtime state, session-
level controls), but it is no longer the primary navigation key.

---

## Product Principles

1. **Intent first** — the main user action is expressing intent. The UI
   should not force users to configure a chat before they can write.
2. **One composer** — direct, group, and future task chats share one
   composer interaction. Target selection determines the chat shape.
3. **No modal by default** — chat creation is inline. Modals are reserved
   for advanced settings.
4. **Chat is navigation** — the left rail navigates conversations; agents
   and humans are collaborators selected inside the workflow.
5. **Progressive disclosure** — agent management lives in Team / Settings.

---

## Goals

- Make conversation the primary navigation object in Workspace.
- Remove agent rows from the Workspace left rail.
- Let users start direct and group chats without a modal.
- Let users add chat members with the same picker pattern.
- Surface unread `@` mentions on conversation rows.
- Keep the notification bell for system-level events only.
- Leave room for future task chats without depending on the Task primitive.

## Non-goals

- Implement the Task primitive.
- Build task board / lifecycle / task-specific filtering.
- Require group chat naming during creation.
- Build full IM administration controls (mute, archive, kick, role
  management).
- Replace Team or Settings pages for agent management.

---

## Product Model

This design does not introduce a new standalone chat business entity. The
existing Hub model is reused and extended:

```text
chats                    — conversation identity, navigation row
messages                 — immutable message log
chat_participants        — speaking participants only (deliverable)
chat_subscriptions (NEW) — non-speaking observers (watchers)
agent_chat_sessions      — runtime state inside a chat
```

In short:

```text
Chat            = conversation identity and user navigation identity
Speaking        = chat_participants row → receives inbox fan-out
Watching        = chat_subscriptions row → no inbox row, has read state
Agent session   = runtime execution state inside a chat
```

### Why a separate `chat_subscriptions` table

A previously circulated proposal added `role = 'watcher'` to
`chat_participants`. That option breaks the strong existing invariant:

> A row in `chat_participants` ⇒ the agent is in the chat's fan-out set.

Mixing speakers and watchers in the same table forces every consumer to
learn the new rule and add `WHERE role != 'watcher'` (message fan-out,
mention candidate resolution, direct → group upgrade count, future
analytics, etc.). A single missed filter would result in inbox double
delivery, miscounted group-upgrade thresholds, or watchers appearing as
mention candidates.

A separate `chat_subscriptions` table preserves the invariant. Hot paths
(`services/message.ts`, `services/inbox.ts`, message-dispatcher payload
build) need **zero** changes to their participant filters. The only new
work is two well-bounded transitions (`join`, `leave`) and three
recompute helpers (chat / agent / member dimension) for lifecycle events.

---

## Workspace Visibility

Workspace shows two row kinds:

```text
A. Participant chats
   The current member's human agent has a `chat_participants` row.

B. Watching chats
   At least one agent managed by the current member is a participant,
   AND the current member's human agent is NOT a participant.
   The current member has a `chat_subscriptions` row instead.
```

The two states must be visually and behaviourally distinct:

```text
participant
→ can read, can reply
→ composer enabled
→ normal conversation row

watching
→ can read, cannot reply yet
→ composer replaced by "Join to reply"
→ row / header show "Watching"
```

Opening a watching chat does not implicitly add the user as a speaker.
Joining is an explicit action.

---

## Information Architecture

```text
Workspace
├─ Conversation List
│  ├─ New chat
│  ├─ Direct chats
│  ├─ Group chats
│  └─ Future task chats
├─ Chat Surface
│  ├─ New chat draft
│  ├─ Selected chat
│  └─ Welcome suggestions
└─ Composer
   ├─ Target picker in draft chats
   ├─ Participants and add-member control in existing chats
   └─ Message input
```

### Primary Screen

```text
┌────────────────────────────────────────────────────────────────────┐
│ Workspace / Context / Team / Settings                    Bell User │
├──────────────────────┬─────────────────────────────────────────────┤
│ Conversations        │ New chat                                    │
│                      │                                             │
│ + New chat           │             Hi, I'm code agent              │
│                      │                Try asking                   │
│ ● Fix build error    │   [List my open tasks by priority]          │
│   Code Agent · 2m    │   [Summarize what I did today]              │
│                      │   [Plan what to work on next]               │
│   Review layout      │                                             │
│   Design + Gandy     │ ┌─────────────────────────────────────────┐ │
│   18m ago            │ │ Tell code agent what to do...           │ │
│   Plan next sprint   │ │ To: code agent ▼                   Send │ │
│   Product Agent +2   │ └─────────────────────────────────────────┘ │
└──────────────────────┴─────────────────────────────────────────────┘
```

### Conversation List rules

- Compact rows (~56-64px). First line: title + last activity time. Second
  line metadata priority: `Error` / `Blocked` > `Watching` > participant
  summary > last-message preview.
- Time = last activity time, not join / creation.
- Participant names are metadata, never the primary title.
- Selected row uses an active background and left accent border.
- Unread mention rows show the red dot AND a bolder title.
- v1 filters: `All`, `Unread`, `Watching`. Do not split by chat type.

### Chat Surface rules

- Reuse existing chat-view structure (header, timeline, composer, mention
  autocomplete, image upload, rename).
- Header title = conversation title, not primary agent name.
- Header subtitle = participants and high-level activity, not session
  debug facts.
- Render from `chatId`. `agentId` is derived from participants and
  sessions when needed.
- Session-level controls (suspend, terminate) move to the context panel
  or an overflow menu.

### Watching Chat rules

- Opening a watching chat never auto-joins.
- Composer is replaced with a single `Join to reply` action.
- Join transitions the row from `chat_subscriptions` to
  `chat_participants` with state carry (`last_read_at`,
  `unread_mention_count`).

### Responsive behavior

- `>= 1200px`: three columns (list + surface + context).
- `768-1199px`: two columns; context as right drawer.
- `< 768px`: single pane; list ↔ surface with back button.

---

## Data Model

This is the normative schema. Implementation MUST match these shapes; the
appendix shows specific Drizzle / migration realisations.

### `chats` — projection columns added

```text
chats
├─ ...existing columns
├─ last_message_at      timestamptz NULL
└─ last_message_preview text         NULL    -- first 200 chars of last message
```

Index:

```text
idx_chats_org_last_message(organization_id, last_message_at DESC)
```

### `chat_participants` — read-state columns added

```text
chat_participants
├─ ...existing columns (chat_id, agent_id, role, mode, joined_at)
├─ last_read_at          timestamptz NULL
└─ unread_mention_count  int NOT NULL DEFAULT 0
```

The existing `role = 'owner' | 'member'` enum is preserved. **No
`watcher` role**. Watcher rows live in `chat_subscriptions`.

### `chat_subscriptions` — NEW

```text
chat_subscriptions
├─ chat_id               text NOT NULL  REFERENCES chats(id) ON DELETE CASCADE
├─ agent_id              text NOT NULL  REFERENCES agents(uuid)
├─ kind                  text NOT NULL  DEFAULT 'watching'   -- enum, future-extensible
├─ last_read_at          timestamptz NULL
├─ unread_mention_count  int NOT NULL  DEFAULT 0
├─ created_at            timestamptz NOT NULL DEFAULT NOW()
└─ PRIMARY KEY (chat_id, agent_id)

INDEX idx_chat_subscriptions_agent (agent_id)
```

### Invariants

1. **Mutual exclusion**: an `(chat_id, agent_id)` pair never has rows in
   both `chat_participants` and `chat_subscriptions` at the same time.
   Transitions enforce this atomically (see §"State Transitions").
2. **Fan-out exclusivity**: only `chat_participants` rows produce
   `inbox_entries`. `chat_subscriptions` rows are observer-only and never
   trigger delivery.
3. **Mention candidates**: `@<name>` resolution against a chat reads
   from `chat_participants` only. Watchers cannot be `@`-mentioned
   directly.
4. **`chat.type` upgrade only**: direct → group when speaking
   participants reach 3. Never downgrades.

---

## State Transitions

### Watcher → Participant (`join`)

Single transaction, state carry:

```text
BEGIN;
  carried = DELETE FROM chat_subscriptions
            WHERE chat_id = $1 AND agent_id = $2
            RETURNING last_read_at, unread_mention_count;

  if exists chat_participants(chat_id=$1, agent_id=$2) → no-op
  else
    -- chat-upgrade rule: count current speakers
    cnt = SELECT count(*) FROM chat_participants WHERE chat_id = $1;
    if cnt + 1 >= 3 AND chats.type = 'direct'
      UPDATE chats SET type = 'group' WHERE id = $1 AND type = 'direct';
      UPDATE chat_participants SET mode = 'mention_only'
        WHERE chat_id = $1
          AND agent_id IN (non-human existing speakers);

    INSERT INTO chat_participants
      (chat_id, agent_id, role, mode, last_read_at, unread_mention_count)
    VALUES ($1, $2, 'member', 'full',
            COALESCE(carried.last_read_at, NULL),
            COALESCE(carried.unread_mention_count, 0));
COMMIT;
```

If no `chat_subscriptions` row existed but the user has visibility into
the chat (member/admin in chat's org), the INSERT defaults to NULL /
0.

### Participant → Watcher (`leave`)

Single transaction, conditional state carry:

```text
BEGIN;
  carried = DELETE FROM chat_participants
            WHERE chat_id = $1 AND agent_id = $2
            RETURNING last_read_at, unread_mention_count;

  -- Should this user still see the chat (i.e. still manages a participant)?
  stillVisible = EXISTS (
    SELECT 1
    FROM chat_participants cp
    JOIN agents  a ON a.uuid = cp.agent_id
    JOIN members m ON m.id   = a.manager_id
    WHERE cp.chat_id = $1
      AND m.agent_id = $2          -- $2 is the user's human agent uuid
      AND m.status   = 'active'
  );

  if stillVisible
    INSERT INTO chat_subscriptions
      (chat_id, agent_id, kind, last_read_at, unread_mention_count)
    VALUES ($1, $2, 'watching', carried.last_read_at, carried.unread_mention_count);
  -- else: user fully detaches from the chat
COMMIT;
```

### Lifecycle helpers (recompute)

Used for *set rebuilds*, never for state-carry transitions:

```ts
recomputeChatWatchers(tx, chatId): Promise<void>
recomputeWatchersForAgent(tx, agentId): Promise<void>
recomputeWatchersForMember(tx, memberId): Promise<void>
```

When invoked:

| Event                                  | Helper                                    |
| -------------------------------------- | ----------------------------------------- |
| Chat created with non-self participants | `recomputeChatWatchers(chatId)`          |
| `addParticipant` adds a non-human       | `recomputeChatWatchers(chatId)`          |
| `removeParticipant` removes a non-human | `recomputeChatWatchers(chatId)`          |
| `rebindAgent` (manager change)          | `recomputeWatchersForAgent(agentId)`     |
| Member status flip (active ↔ left)      | `recomputeWatchersForMember(memberId)`   |
| Chat deleted                            | ON DELETE CASCADE                         |
| `join` / `leave`                        | **Do not call** — state carry SQL above   |

**Critical invariant**: recompute helpers MAY default `last_read_at = NULL`
and `unread_mention_count = 0` for newly-inserted rows. They MUST NOT be
called on the `join` / `leave` path or read state will be lost.

---

## Mention Resolution and Propagation

These are two distinct steps; the first determines who is mentioned, the
second updates counters. Splitting them keeps the watcher invariant
explicit.

### Mention resolution (read-only, in `services/message.ts`)

```text
input  : message.content + chat_participants(chat_id) joined to agents
output : list of agent uuids mentioned (sender excluded)
rule   : watchers (chat_subscriptions) are NEVER candidates
```

This is the existing `extractMentions` flow. No change.

### Mention propagation (write, in `services/message-dispatcher.ts` post fan-out)

After fan-out completes (still inside the same transaction), execute:

```sql
-- speaker counters
UPDATE chat_participants
   SET unread_mention_count = unread_mention_count + 1
 WHERE chat_id = :chatId
   AND agent_id = ANY(:mentioned_uuids)
   AND agent_id <> :sender;

-- watcher counters: a non-human mention propagates to its manager's watcher row
UPDATE chat_subscriptions
   SET unread_mention_count = unread_mention_count + 1
 WHERE chat_id = :chatId
   AND agent_id IN (
     SELECT m.agent_id                       -- manager's human agent uuid
       FROM agents a
       JOIN members m ON m.id = a.manager_id
      WHERE a.uuid = ANY(:mentioned_uuids)
        AND a.type <> 'human'
        AND m.status = 'active'
   );
```

### Last-message projection (same transaction, after fan-out)

```sql
UPDATE chats
   SET last_message_at = NOW(),
       last_message_preview = LEFT(:content_text, 200),
       updated_at = NOW()
 WHERE id = :chatId;
```

`:content_text` is the persisted `content::text` (or empty for non-text
formats — UI treats null preview as "[image]" / "[file]").

---

## Realtime Behavior Contract (best-effort)

```text
After a message is durable and fan-out is committed, every user who has
either a chat_participants row or a chat_subscriptions row for that chat
SHOULD see one chat:message frame on their open admin WS within ~1s.

Web on receipt:
  - invalidate ["me", "chats"] queries
  - if currently viewing chatId, append/refetch messages

Realtime is best-effort. Failure MUST log + swallow; never block message
persistence or inbox delivery.

WS reconnect MUST refetch /me/chats and the selected chat's messages.
```

### Two delivery paths

```
speaking participant
  → already gets inbox NOTIFY (existing path)
  → admin WS observes the participant's inbox push and translates it into
    a chat:message frame for the same socket.

watcher
  → no inbox row exists (Invariant 2)
  → cross-process signal needed. New PG NOTIFY channel.
```

Channel name and payload schema are implementation details; see appendix
R-1.

---

## API Contract

All new member-facing chat APIs live under `/me/*`. `/admin/chats/*` stays
in place for compatibility (audit + admin-only listing). `workspace` is a
UI concept and does not appear in the API path.

```text
GET    /me/chats                          — paginated list
POST   /me/chats                          — create
POST   /chats/:chatId/read                — mark-read
POST   /chats/:chatId/participants        — add member
POST   /chats/:chatId/workspace-join      — watcher → speaker
POST   /chats/:chatId/workspace-leave     — speaker → watcher (or detach)
```

Note: an earlier draft listed these under `/me/chats/...`; the actual
shipping routes live under `/chats/...` (see `packages/server/src/api/chats.ts`
+ `me-chats.ts`). The v1 supervision-check `POST /chats/:chatId/join` route
was removed alongside its `chat.ts::joinChat` service — the v2 watcher-based
`/workspace-join` is the only "manager joins chat" path today.

### `GET /me/chats`

Query:

```ts
type ListMeChatsQuery = {
  cursor?: string;            // base64 of "<lastMessageAtIso>|<chatId>"
  limit?: number;             // default 50, max 200
  filter?: 'all' | 'unread' | 'watching';   // default 'all'
};
```

Response:

```ts
type MeChatRow = {
  chatId: string;
  type: 'direct' | 'group';
  membershipKind: 'participant' | 'watching';
  title: string;
  topic: string | null;
  participants: Array<{
    agentId: string;
    displayName: string;
    type: 'human' | 'personal_assistant' | 'autonomous_agent';
  }>;
  participantCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadMentionCount: number;
  canReply: boolean;
  taskId: string | null;     // null until Task primitive lands
  taskStatus: string | null; // null until Task primitive lands
};

type ListMeChatsResponse = {
  rows: MeChatRow[];
  nextCursor: string | null;
};
```

Rules:

- Returns rows where the current user's human agent has either a
  `chat_participants` row or a `chat_subscriptions` row for the chat.
- `participant` → `canReply = true`. `watching` → `canReply = false`.
- Nested chats (rows with `parent_chat_id IS NOT NULL`) are filtered out;
  the column is reserved for a future nested-chat model.
- Sort: `(chats.last_message_at DESC NULLS LAST, chats.id DESC)`. Anchored
  on `idx_chats_org_last_message`.
- Acceptance: p95 < 200ms at 1k chats.

### `POST /me/chats`

Body:

```ts
type CreateMeChatBody = {
  participantIds: string[];   // non-self agent uuids; ≥ 1
  topic?: string | null;
};
```

Rules:

- Current user's human agent is auto-included as `role = 'owner'`,
  `mode = 'full'`.
- **Always create a new chat.** No dedupe of direct chats or exact
  participant sets. (Known UX trade-off — see §Open Questions.)
- 1 non-self participant → `type = 'direct'`. ≥ 2 non-self participants →
  `type = 'group'`.
- All participants must be visible and in the same organisation.
- Watcher rows are upserted via `recomputeChatWatchers(chatId)`.

Returns the created chat with participants.

### `POST /me/chats/:chatId/participants`

Body:

```ts
type AddParticipantsBody = {
  participantIds: string[];   // non-empty
};
```

Rules:

- Existing speaking participants are returned as no-ops (idempotent).
- Adding the third (or later) speaker upgrades a `direct` chat to
  `group`. `group` never downgrades.
- Server enforces visibility and organisation boundaries.
- After the inserts, run `recomputeChatWatchers(chatId)` to maintain
  watcher rows for managers of newly-added non-humans (and to clear
  watcher rows for managers whose only managed participant just turned
  into a speaker).

### `POST /me/chats/:chatId/read`

Marks the current user's row read:

```sql
-- whichever of the two tables holds the row for this user
UPDATE chat_participants
   SET last_read_at = NOW(), unread_mention_count = 0
 WHERE chat_id = :chatId AND agent_id = :humanAgentId;

UPDATE chat_subscriptions
   SET last_read_at = NOW(), unread_mention_count = 0
 WHERE chat_id = :chatId AND agent_id = :humanAgentId;
```

Both UPDATEs run; whichever row exists takes effect. Idempotent.

Returns `{ chatId, lastReadAt, unreadMentionCount: 0 }`.

### `POST /chats/:chatId/workspace-join`

Watcher → speaking participant. Single-table UPDATE on
`chat_membership.access_mode` ('watcher' → 'speaker'); `chat_user_state`
rows for the (chat, agent) pair are not touched (read state survives the
flip — see §State Transitions).

Refuses with 403 if the caller has no watcher row in the chat (admins
without a managed participant must not be able to drop into arbitrary
chats); refuses with 409 if the caller is already a speaker. See
`packages/server/src/services/watcher.ts::ensureCanJoin`.

Returns 204.

### `POST /chats/:chatId/workspace-leave`

Speaking participant → watcher (if `stillVisible`) or fully detach.
Single-table UPDATE on `chat_membership.access_mode`; `chat_user_state`
row (if any) is preserved per §11.4 default — read state is remembered
for re-add.

Returns `{ chatId, membershipKind: 'watching' | null }`.

---

## Notification Model

```text
Conversation row red dot
├─ Unread @mentions in direct chats
└─ Unread @mentions in group chats (incl. watcher mentions)

Notification bell
├─ agent_error
├─ agent_blocked
├─ agent_stale
├─ session_error
├─ session_completed
└─ computer / system / organisation events
```

The bell does NOT show chat-mention notifications. System notifications
that reference a chat MAY navigate to `/?c=<chatId>`.

---

## URL Model

```text
/                       → workspace, no chat selected (or draft)
/?c=<chatId>            → workspace with chatId selected
```

Legacy compat:

```text
/?a=<agentId>           → workspace with no chat selected
/?a=<agentId>&c=<chatId> → routed to /?c=<chatId>; agentId ignored
```

Web reads `chatId` first; `agentId` is derived from the chat's
participants when needed. v1 redirects/derives from the legacy form so
existing bookmarks keep working.

---

## Risk Constraints

To minimise regression risk in the message + inbox path:

1. **Do not modify** existing logic in `services/message.ts`,
   `services/inbox.ts`, or message-dispatcher payload-assembly functions.
   Bug-prone hot paths (fan-out, mention extraction, silent context replay,
   inbox dedupe) MUST stay byte-identical.
2. **One sanctioned extension point** in `services/message-dispatcher.ts`
   (or a dedicated post-tx hook): an *append-only* "after fan-out" step
   that runs the mention propagation + chats projection updates inside
   the same transaction. New code; no edits to existing helpers.
3. **Watcher rows MUST NEVER receive inbox entries.** Tested explicitly.
4. **Do not reuse inbox `acked` as web read state** — semantics differ
   (delivery state vs human reading state).
5. **Do not piggyback read writes into `sendMessage`.** Mark-read is a
   member action.
6. **Realtime `chat:message` is best-effort.** Failure must log + swallow.
7. **Watcher recompute is set-based.** Never use it on `join` / `leave`.
8. **Audience cache is single-instance correct only (v1).** The
   in-process cache in `services/chat-audience-cache.ts` (TTL 5s) does
   not propagate participant-set changes across replicas. Until a
   `chat:audience` PG NOTIFY channel is added (v1.1 follow-up), Hub
   deployments MUST run as a single API instance, **or** route admin-WS
   connections with sticky session affinity. Without one of those, an
   add-participant on replica A leaves replica B serving stale audiences
   for up to 5 seconds, during which the newly-added speaker won't
   receive `chat:message` pushes. (Reviewer #228 finding 4.)

---

## Empty, Loading, and Error States

- **Empty list**: "No conversations yet. Start with New chat."
- **Draft without network**: keep message in composer; surface error.
- **Offline target**: keep selectable; composer shows "queue" hint.
- **Permission failure**: drop offending target, preserve typed text.

---

## Accessibility

- Target picker rows keyboard-navigable.
- Selection state via `aria-selected`.
- Picker trigger announces selected targets.
- Red-dot unread state must not be color-only; expose
  `aria-label="N unread mentions"`.
- Send button keyboard-reachable.
- Focus returns to composer after target selection.

---

## Open Questions

- **Direct chat dedupe (UX risk)**: v1 always creates a new chat. Where
  does a user see all conversations they have had with the same person /
  agent? Recommendation: future "person view" off the participant chip;
  acknowledge as a v2 follow-up. Add a "search" hint to the conversation
  list so the same-name pile is at least findable.
- **Authoritative source for "primary assistant"**: `personal_assistant`
  agent owned by the user, fallback to most-recent agent. (To be confirmed
  with product before the picker default ships.)
- **Mark-read trigger**: after the message-list has loaded for the
  selected chat (recommended for v1).
- **System notifications referencing a chat** route to `/?c=<chatId>`.

### Resolved

- Direct chats are NOT deduped; same for group exact-set.
- Nested chats (`parent_chat_id IS NOT NULL`) do NOT appear in the list;
  `parent_chat_id` is reserved for a future nested-chat model.
- SDK helpers move to a separate PR (out of scope here).
- Watcher state lives in `chat_subscriptions`, not `chat_participants`.
- `chat.type` upgrades direct → group; never downgrades.

---

## Acceptance Criteria

- Workspace left rail contains conversations only.
- Agent rows are not shown in Workspace.
- Clicking New chat opens an inline draft and focuses the composer.
- The default target is selected automatically.
- Sending to one target creates a new direct chat.
- Sending to multiple targets creates a group chat.
- Group chat creation does not open a dialog and does not require a name.
- Existing chats can add members without a dialog.
- Watching chats appear with a clear "Watching" state.
- Opening a watching chat does not auto-join.
- "Join to reply" upgrades the watcher row to a speaking participant
  (state preserved).
- Conversation rows show unread `@` red dots.
- Opening a chat clears its unread mention state.
- Notification bell does not show chat-mention notifications.
- Task fields are present in the API shape but `null` until Task
  primitive support lands.
- `/me/chats` p95 latency < 200ms at 1k chats.

---

## Implementation Plan

This design ships as **one PR** covering backend + realtime + web UI.
Strict file-touch boundaries (see §Risk Constraints) keep the regression
surface bounded.

Order of work inside the PR:

1. **Migration** (one file): `chat_subscriptions` table; columns on
   `chat_participants` (`last_read_at`, `unread_mention_count`); columns
   + index on `chats` (`last_message_at`, `last_message_preview`); single
   data-backfill block.
2. **Service layer**:
   - `services/watcher.ts` — `recompute*` helpers + state-carry
     transitions for join/leave.
   - `services/chat-projection.ts` — mention propagation + chats
     projection update; called immediately after the existing fan-out
     (no edit to fan-out itself).
   - `services/me-chat.ts` — list / create / mark-read / add-participant /
     join / leave, with cursor pagination.
3. **API** (one new file): `api/me-chats.ts` exposing `/me/chats*` under
   the existing `meRoutes` mount.
4. **Realtime**:
   - admin WS opt-in subscription per session (`chat:message` frame
     interest) + per-socket fan-out.
   - PG NOTIFY channel for watcher pushes (impl detail).
5. **Web**:
   - new `ConversationList` component; `WorkspacePage` switches to it.
   - `NewChatDraft` + `TargetPicker` + `ParticipantsHeader` +
     `AddMembersPicker`.
   - "Join to reply" composer for watching chats.
   - admin WS hook learns to invalidate `["me", "chats"]` on
     `chat:message`.
   - legacy `?a=&c=` redirect to `?c=`.
6. **Tests**:
   - service-layer unit tests (transitions, recompute idempotence,
     mention propagation, projection, pagination).
   - invariant tests: watchers never get `inbox_entries`; mention
     resolution never includes watcher rows.
   - web component smoke tests + Playwright happy path.

---

## Appendix

### R-1 — Realtime implementation hint

- Channel: `chat_message_events`. Payload: `<chatId>:<messageId>`.
- Producer: post-fan-out hook in `services/chat-projection.ts` issues a
  best-effort `pg_notify`.
- Consumer: admin WS LISTEN handler resolves chat → user list (one query
  per push, cached briefly in-process). For each open admin socket whose
  `(userId, organizationId)` intersects, writes the JSON frame
  `{ "type": "chat:message", "chatId": "..." }`.
- Failure of producer or consumer logs and is dropped. Web reconnect
  refetches `/me/chats`.

### R-2 — Backfill SQL recipe

```sql
-- chats projection backfill (single SQL, no per-row subqueries)
WITH last_msg AS (
  SELECT DISTINCT ON (chat_id)
    chat_id,
    created_at,
    LEFT(content::text, 200) AS preview
  FROM messages
  ORDER BY chat_id, created_at DESC
)
UPDATE chats c
   SET last_message_at      = lm.created_at,
       last_message_preview = lm.preview
  FROM last_msg lm
 WHERE c.id = lm.chat_id;

-- chat_participants new columns: defaults handle the rest.

-- chat_subscriptions backfill (every active manager of a chat participant
-- that is not themselves a speaker in that chat)
INSERT INTO chat_subscriptions
  (chat_id, agent_id, kind, last_read_at, unread_mention_count, created_at)
SELECT DISTINCT cp.chat_id, m.agent_id, 'watching', NULL, 0, NOW()
  FROM chat_participants cp
  JOIN agents  a ON a.uuid = cp.agent_id
  JOIN members m ON m.id   = a.manager_id
 WHERE m.status = 'active'
   AND a.type <> 'human'
   AND NOT EXISTS (
     SELECT 1 FROM chat_participants cp2
      WHERE cp2.chat_id = cp.chat_id
        AND cp2.agent_id = m.agent_id
   )
ON CONFLICT (chat_id, agent_id) DO NOTHING;
```

Deployment ordering: ship the migration in the same release as the
service code that knows about `chat_subscriptions`. The backfill is the
last statement in the migration.

### R-3 — Existing code touchpoints

- `services/message.ts` — unchanged. Still emits the existing fan-out and
  recipients list.
- `services/message-dispatcher.ts` — unchanged for payload assembly.
- `services/inbox.ts` — unchanged.
- New: `services/chat-projection.ts` — owns the post-fan-out projection +
  mention propagation + `pg_notify('chat_message_events', …)`.
- `api/admin/chats.ts` — kept for admin audit; no edits.
- `api/me.ts` — registers the new `/me/chats*` routes via a sub-import.
- `api/admin/ws-admin.ts` — extended to read the new
  `chat_message_events` LISTEN channel and emit `chat:message` frames
  per-socket.
- Web: `pages/workspace/index.tsx`, `pages/workspace/center/index.tsx`
  pick `ConversationList` over `AgentRoster`.

---

## Context Tree Impact

This design changes the Workspace product model from agent-first to
chat-first and changes the relationship between chat notifications and
system notifications. If adopted, update the Context Tree for Agent Hub /
Web Console before or alongside the implementation PR.
