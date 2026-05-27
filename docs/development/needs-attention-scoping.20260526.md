# Needs-Attention Scoping — Technical Design (2026-05-26)

> Status: **draft — pending review by gandy-s-assistant + gandy2025**
> Author: gandy-developer
> Scope: chat-granularity attention predicate (no item-level, no inbox, no dismiss/snooze, no schema migration).

## 1. Problem & Locked Rules (recap)

The Agent Hub Web me-chat list pins a chat into the "Needs attention" bucket when *any* speaker agent is `failed` or *any* agent has a pending `AskUserQuestion`. There is no "is this related to me?" filter — so a watcher (or even a speaker peer) sees attention pins for other people's broken / waiting agents.

Discussion with the user has locked the new predicate:

```
chat ∈ Needs Attention ⇔ any of:
  R1. agent ∈ chat has main = failed       AND  agent.manager = caller_member
  R2. agent ∈ chat has pending question    AND  agent.manager = caller_member
  R3. agent ∈ chat has pending question    AND  caller is a human SPEAKER in chat
  R4. unread_mention_count(chat, caller) > 0
```

Boundaries already locked: A (manager wins over watcher/speaker membership for R1+R2), B (R3 fires even for someone else's agent), C (R3 fires for every speaker when there are multiple humans — accepted as noise vs precision tradeoff). No UI toggle.

## 2. Current State — Verified

| Concern                                | File                                                                              | Notes                                                                  |
|----------------------------------------|-----------------------------------------------------------------------------------|------------------------------------------------------------------------|
| Backend per-chat status producer       | `packages/server/src/services/agent-chat-status.ts:314-455`                       | `resolveAgentChatStatuses` — viewpoint-agnostic; should stay that way. |
| Backend per-row projection (caller-scoped) | `packages/server/src/services/me-chat.ts:442-478`                            | `failedAgentIds` is speaker-filtered; `pendingQuestionAgentIds` is NOT. Neither is manager-filtered. |
| Route handler (knows caller identity)  | `packages/server/src/api/orgs/chats.ts:94`                                        | Already has `scope.memberId` and `scope.humanAgentId`. Passes only the latter.        |
| Frontend attention predicate           | `packages/web/src/pages/workspace/conversations/group-rows.ts:189-225`            | `splitAttentionRows` consumes `failedAgentIds.length`, `pendingQuestionAgentIds.length`. |
| Wire schema                            | `packages/shared/src/schemas/me-chat.ts:188-287`                                  | Two zod arrays with `.default([])` for version skew.                   |
| Agent → manager link                   | `packages/server/src/db/schema/agents.ts:47` (`managerId text NOT NULL`)          | Indexed: `idx_agents_manager`. `managerId` = `members.id` (not `users.id`). |
| Caller speaker / watcher per chat      | `chat_membership.access_mode` — already selected as `r.access_mode` in the main JOIN | No extra join needed.                                                  |
| Mention count                          | `chat_user_state.unread_mention_count` — already selected as `r.unread_mention_count` | No extra join needed.                                                  |
| `pending_questions` schema             | `packages/server/src/db/schema/pending-questions.ts`                              | No addressee field — out of scope for this fix.                        |

## 3. Design Decisions

### 3.1 Where does the manager filter live?

`resolveAgentChatStatuses` returns full per-chat status arrays and is shared with `GET /chats/:id/agent-status` (panel view, where every speaker should show regardless of manager). **Keep it viewpoint-agnostic.** The manager filter belongs to the *caller-scoped projection* — i.e. inside `me-chat.ts:listMeChats`.

### 3.2 Field semantics — narrow the existing fields, add ONE small new field

**Narrow** `failedAgentIds` and `pendingQuestionAgentIds` semantics: they become **"agents I manage in this chat that …"**.

**Add** `chatHasOpenQuestion: boolean` — pure raw "ANY agent in this chat has a pending question". Drives R3 alone.

Why narrow vs add a parallel "mine" field?

- The badges on the chat row (`failed` red dot, `needsYou` orange dot — see `chat-row-avatar-preview.tsx:275-276`) **should** also narrow to "mine". Today a watcher sees a red dot for someone else's broken agent — exactly the same badcase pattern. Narrowing the field repairs the badge for free.
- A parallel `myFailedAgentIds` would double the wire footprint, and we'd have to also decide what `failedAgentIds` is supposed to communicate after the fix. Cleaner to repurpose.
- `chatHasOpenQuestion` is a single bit, only consulted by R3. The cost is negligible.

Rejected alternatives:

- **Single computed `needsAttention` boolean from server.** Tempting (one bit replaces all the logic), but the front-end still needs the failed-vs-needs-you priority for sort ordering inside the bucket, AND the row badges need to know individually. So the front-end loses fidelity. Skip.
- **Pass `memberId` to `resolveAgentChatStatuses` and have it filter.** Couples viewpoint to the shared producer; would force `GET /chats/:id/agent-status` to acquire a viewpoint param too. Skip.

### 3.3 Caller-is-speaker check (R3 needs it)

Already available **for free** in the existing per-row data: `r.access_mode` is selected from `cm.access_mode` where `cm.agent_id = humanAgentId`. So:

```ts
const callerIsHumanSpeaker = r.access_mode === "speaker";
```

(Humans never have `access_mode` other than speaker / watcher; no other check needed.)

### 3.4 Mention (R4) — where does the predicate live?

`unreadMentionCount` is already on `MeChatRow`. The cleanest place to add R4 is the **frontend** `splitAttentionRows` (same place as R1/R2/R3 consumption), not a new server field. Front-end already reads `r.unreadMentionCount` for the unread bold styling.

### 3.5 Attention bucket sort priority (3-tier now)

Today: `failed` > `needs_you`, delegated to shared `compareMainStatus`.

After: `failed` > `needs_you` > `mention`. `compareMainStatus` is keyed on agent main-status enum (failed/needs_you/working/…); `mention` is a chat-level signal that doesn't fit that ladder. Add a local `ATTENTION_PRIORITY` const in `group-rows.ts` rather than overload the shared comparator.

Sort rule: a chat that triggers multiple reasons sorts under its highest-priority reason. A chat that is both failed AND has a mention sorts as failed.

## 4. Field Changes

### 4.1 `MeChatRow` (`packages/shared/src/schemas/me-chat.ts`)

```ts
// SEMANTIC NARROW — no schema shape change.
failedAgentIds: z.array(z.string()).default([]),
  // Was: every failed non-human SPEAKER in this chat.
  // Now: every failed non-human SPEAKER in this chat that the CALLER manages
  //      (agents.manager_id = caller.member_id).

pendingQuestionAgentIds: z.array(z.string()).default([]),
  // Was: every non-human agent in this chat with a PENDING AskUserQuestion
  //      (NOT speaker-filtered — preserved).
  // Now: every non-human agent in this chat with a PENDING AskUserQuestion
  //      that the CALLER manages.

// NEW FIELD.
chatHasOpenQuestion: z.boolean().default(false),
  // True iff ANY non-human agent in this chat has a PENDING question
  // (raw, unfiltered). Drives R3 (caller-is-speaker fallback) on the front-end.
  // .default(false) for version skew: old server → new web reads `false`,
  // which keeps the conservative R1/R2/R4 behaviour while the deploy progresses.
```

`busyAgentIds` is **not** narrowed — `busy` is a live-activity indicator, not an attention signal, and a watcher seeing "someone is working" is correct, not noise.

### 4.2 No schema migration

`agents.manager_id` exists and is indexed. `chat_membership.access_mode` exists. `chat_user_state.unread_mention_count` exists. No DB changes.

## 5. Backend Implementation Plan

### 5.1 Route — `packages/server/src/api/orgs/chats.ts:94`

```diff
- return listMeChats(app.db, scope.humanAgentId, scope.organizationId, query);
+ return listMeChats(app.db, scope.humanAgentId, scope.memberId, scope.organizationId, query);
```

The "Class B → mine-scope" route already builds `scope` via `requireOrgMembership`, which produces both `humanAgentId` and `memberId`.

### 5.2 Service signature

```ts
export async function listMeChats(
  db: Database,
  humanAgentId: string,
  callerMemberId: string,     // NEW
  organizationId: string,
  query: ListMeChatsQuery,
): Promise<ListMeChatsResponse> { ... }
```

(Existing tests pass `humanAgentId` and `organizationId` only — they'll need a `callerMemberId` arg too. Helpers already track `admin.memberId`, so the diff is trivial.)

### 5.3 Within `listMeChats` — the projection loop

After the existing participant lookup, but before the per-chat projection (`for (const [chatId, statuses] of statusByChat)`):

```ts
// Set of agent UUIDs the caller manages — used to narrow failed/pending
// projections to "mine". One indexed read (`idx_agents_manager`); the
// chat-list is necessarily org-scoped so we add organization_id for
// belt-and-braces. Caller's own human agent has manager_id = caller's
// own member_id (Phase 2 of agent-naming refactor), so the set is
// self-inclusive — harmless because human agents never produce
// pending questions or failed sessions.
const managedRows = await db
  .select({ uuid: agents.uuid })
  .from(agents)
  .where(and(eq(agents.managerId, callerMemberId), eq(agents.organizationId, organizationId)));
const managedAgentIds = new Set(managedRows.map((r) => r.uuid));
```

Inside the existing projection loop, refine the field builders:

```ts
const failed: string[] = [];
const pending: string[] = [];
const busy: string[] = [];
let chatHasOpenQuestion = false;
for (const s of statuses) {
  const isSpeaker = speakers?.has(s.agentId) ?? false;
  const isMine = managedAgentIds.has(s.agentId);
  // live-dot / busy — unchanged semantics
  if (isSpeaker && s.activity) { /* ... */ }
  if (isSpeaker && s.working) busy.push(s.agentId);
  // failed — speaker-filtered AND narrowed to mine (R1).
  if (isSpeaker && s.main === "failed" && isMine) failed.push(s.agentId);
  // pending — NOT speaker-filtered (matches existing behaviour for a
  // pending agent that has since left). NARROWED to mine (R2).
  if (s.needsYou && isMine) pending.push(s.agentId);
  // chatHasOpenQuestion — raw bit feeding R3 on the front-end. Computed
  // over the same union (non-human speakers + non-human pending) that
  // resolveAgentChatStatuses returns, so a pending agent that has left
  // still flips this true (parity with the current `pending` field).
  if (s.needsYou) chatHasOpenQuestion = true;
}
```

Wire the new boolean into the row:

```ts
return {
  ...,
  pendingQuestionAgentIds: pendingByChat.get(r.chat_id) ?? [],
  failedAgentIds: failedByChat.get(r.chat_id) ?? [],
  busyAgentIds: busyByChat.get(r.chat_id) ?? [],
  chatHasOpenQuestion: hasOpenQuestionByChat.get(r.chat_id) ?? false,
};
```

(One new `Map<string, boolean>` alongside the three existing maps.)

### 5.4 SQL impact

| Query                              | Before        | After       | Notes                                       |
|------------------------------------|---------------|-------------|---------------------------------------------|
| main `chats` JOIN                  | unchanged     | unchanged   | No new joins / filters.                     |
| `participantRows` lookup           | unchanged     | unchanged   |                                             |
| `resolveAgentChatStatuses` reads   | unchanged     | unchanged   | Viewpoint-agnostic by design.               |
| **NEW** `managedAgentIds` lookup   | n/a           | 1 indexed scan on `idx_agents_manager`. Bounded by caller's managed-agent count (typically <50). One round-trip. |

Negligible. The managed-agents set is a per-request constant; it's cheaper than the participants lookup that already happens.

## 6. Frontend Implementation Plan

`packages/web/src/pages/workspace/conversations/group-rows.ts:189-225`:

```ts
const ATTENTION_PRIORITY = ["failed", "needs_you", "mention"] as const;
type AttentionReason = (typeof ATTENTION_PRIORITY)[number];

function rowAttentionReason(r: MeChatRow): AttentionReason | null {
  // R1 — mine failed in chat.
  if (r.failedAgentIds.length > 0) return "failed";
  // R2 — mine pending in chat.   OR
  // R3 — any pending in chat, AND I'm a speaker.
  if (
    r.pendingQuestionAgentIds.length > 0 ||
    (r.chatHasOpenQuestion && r.membershipKind === "participant")
  ) {
    return "needs_you";
  }
  // R4 — unread @-mention.
  if (r.unreadMentionCount > 0) return "mention";
  return null;
}

export function rowIsFailed(r: MeChatRow): boolean {
  return rowAttentionReason(r) === "failed";
}
export function rowNeedsYou(r: MeChatRow): boolean {
  return rowAttentionReason(r) === "needs_you";
}
// (Optional, only if any caller needs it — current consumers don't.)
// export function rowIsMention(r: MeChatRow): boolean { ... }

export function splitAttentionRows(rows: ReadonlyArray<MeChatRow>): {
  attention: MeChatRow[];
  rest: MeChatRow[];
} {
  const attention: MeChatRow[] = [];
  const rest: MeChatRow[] = [];
  for (const r of rows) {
    if (rowAttentionReason(r) !== null) attention.push(r);
    else rest.push(r);
  }
  attention.sort((a, b) => {
    const ra = rowAttentionReason(a);
    const rb = rowAttentionReason(b);
    // Both are non-null inside this bucket; non-null assert via index.
    return ATTENTION_PRIORITY.indexOf(ra!) - ATTENTION_PRIORITY.indexOf(rb!);
  });
  return { attention, rest };
}
```

Side effects on existing consumers:

- `chat-row-avatar-preview.tsx:275-276` (`needsYou={row.pendingQuestionAgentIds.length > 0}` / `failed={row.failedAgentIds.length > 0}`) — these badges **narrow** to "mine". This is **intentional and desired** (manager-noise reduction also for the indicator dots, not just the bucket). Confirmed by the design discussion — a watcher seeing a red `!` on someone else's broken agent is the same badcase pattern.
- `conversations/index.tsx:633-634` — same.

**Bucket vs. badge — important asymmetry:** R3 (peer's agent asking in a chat where I'm a speaker) ENTERS the bucket but does NOT light the `rowNeedsYou` badge. The badge stays specific to R2 ("an agent I manage is waiting on me"). Rationale: `pendingQuestionAgentIds` is now server-narrowed to caller-managed; lighting the orange `?` for a row where the caller manages nothing would contradict the field's wire semantics. The bucket position alone signals R3-only rows; the row's last-message preview surfaces the actual question. The exported `rowAttentionReason(r)` returns the bucket tier (so any future consumer can branch on it without re-deriving) while `rowNeedsYou` stays a badge predicate.

`compareMainStatus` is **not** touched (it's the shared agent-status ladder; mention isn't an agent status).

## 7. Test Matrix

### 7.1 Frontend unit — `packages/web/src/pages/workspace/__tests__/group-rows.test.ts`

Append a new `describe("splitAttentionRows — predicate")` block. Each case is a single fixture row with the boolean fields set; assert `rowAttentionReason` / bucket membership / ordering.

| # | Setup                                                                                          | Expected                                |
|---|------------------------------------------------------------------------------------------------|-----------------------------------------|
| 1 | `failedAgentIds: ["mine"]`                                                                     | attention; reason=failed                |
| 2 | `pendingQuestionAgentIds: ["mine"]`                                                            | attention; reason=needs_you             |
| 3 | `chatHasOpenQuestion: true, membershipKind: "participant"`, mine empty                         | attention; reason=needs_you (R3 path)   |
| 4 | `chatHasOpenQuestion: true, membershipKind: "watching"`, mine empty                            | NOT attention (watcher → R3 not fired)  |
| 5 | `unreadMentionCount: 3`, all else empty                                                        | attention; reason=mention               |
| 6 | All empty / zero                                                                               | NOT attention                           |
| 7 | `failedAgentIds:["x"]` + `unreadMentionCount: 1`                                               | attention; reason=failed (priority wins)|
| 8 | `pendingQuestionAgentIds:["x"]` + `chatHasOpenQuestion: true, membershipKind: participant`     | attention; reason=needs_you (R2 wins over R3, but both produce needs_you; just don't double-count) |
| 9 | Three rows: f, n, m; assert ordered `[f, n, m]` after `splitAttentionRows`                     | sort order honors `ATTENTION_PRIORITY`  |
| 10| `chatHasOpenQuestion: false`, `membershipKind: "participant"`, `pendingQuestionAgentIds: []`   | NOT attention (no question anywhere)    |
| 11| Stable sort within tier: two `failed` rows in input order → preserved in output                | failed-tier order preserved             |

Boundary mapping (from the discussion):
- Boundary A: case 1 with `membershipKind: "watching"` and `failedAgentIds: ["mine"]` → still attention (manager wins over watcher).
- Boundary B: case 3 (1:1 chat shape) and case 4 (watcher) — covered above.
- Boundary C: a single row with `chatHasOpenQuestion: true, membershipKind: "participant"` is enough; the "multiple speakers" replication is a fan-out of the same single-row rule.

### 7.2 Backend integration — new file `packages/server/src/__tests__/me-chat-attention.test.ts`

Patterns adapted from `me-chat-activity.test.ts` (uses `createTestAdmin` / `createTestAgent`). `createTestAgent` creates an admin behind the scenes and sets `managerId = that admin's memberId` — meaning we can simulate "someone else's agent" by calling `createTestAgent(app, ...)` instead of `createTestAgent(app, { ... })` from the current admin's perspective.

Test cases:

| # | Scenario                                                                                                  | Expected projection           |
|---|-----------------------------------------------------------------------------------------------------------|-------------------------------|
| B1 | Caller manages agent A; A is in a chat with caller, A `errored` via session.                              | `failedAgentIds == ["A"]`     |
| B2 | Someone else manages agent X; caller is **speaker** in the chat with X; X `errored`.                      | `failedAgentIds == []`        |
| B3 | Someone else manages agent X; caller is **watcher**; X `errored`.                                         | `failedAgentIds == []`        |
| B4 | Caller manages A; caller is **watcher** of the chat; A `errored`.                                         | `failedAgentIds == ["A"]` (boundary A) |
| B5 | Caller manages A; A has pending question; caller is speaker.                                              | `pendingQuestionAgentIds == ["A"]`, `chatHasOpenQuestion == true` |
| B6 | Someone else manages X; X has pending question; caller is **speaker**.                                    | `pendingQuestionAgentIds == []`, `chatHasOpenQuestion == true` (R3 raw bit) |
| B7 | Someone else manages X; X has pending question; caller is **watcher**.                                    | `pendingQuestionAgentIds == []`, `chatHasOpenQuestion == true` (frontend filters R3) |
| B8 | No agents failed / no pending; caller has a chat with non-zero `unread_mention_count`.                    | All three new fields empty/false (mention is frontend-only). |
| B9 | Multi-chat list: B1 + B2 + B5 + B6 returned in one `listMeChats` call.                                    | Each row independent — no cross-contamination. |
| B10| Caller is in chat with their own human agent only (no others).                                            | All fields empty/false (no false positive from self). |

### 7.3 Existing regressions to keep green

- `me-chat-activity.test.ts` — `liveActivity` is unaffected (busyAgentIds / live dot unchanged).
- `me-chat-source-tags.test.ts` — source counts unaffected.
- `cross-org-chat-pollution.test.ts` — org scoping unaffected.
- `direct-chat-auto-mention.test.ts` — mention logic unaffected.
- `me-chat-service.test.ts` — basic CRUD unaffected; signature change requires passing the new `callerMemberId` arg (small diff).

### 7.4 Static / lint

`pnpm check && pnpm typecheck` from the repo root. The narrowed semantics are documented in the zod schema comments — no signature changes user-visible on the wire.

## 8. Rollout / Version Skew

- `chatHasOpenQuestion` defaults to `false` in the zod schema → old server + new web reads `false` → R3 silently degrades to "off". R1, R2, R4 still fire correctly. Acceptable transient (the only case it affects is "I'm in chat with someone else's agent that asked a question").
- Field semantic narrow on `failedAgentIds` / `pendingQuestionAgentIds` is the BADCASE fix itself — new web + old server would still over-pin (because the old server still returns un-narrowed sets), which is the same buggy behaviour we have today. Acceptable since the web rolls before the server in this codebase.
- No DB migration → instant rollback safe.

## 9. Out of Scope (explicitly)

- `pending_questions.addressee_user_id` — would refine R3 from "any speaker" to "the actual addressee". Deferred (would require schema migration + SDK contract change). The current R3 noise (multi-speaker group chats) is accepted per boundary C.
- Per-user `dismiss` / `snooze` state. Item-level inbox view. Cross-surface unification (GitHub, Adapter). Per the Aha conversation, these are M2-M5; this PR is M1.
- "Show all" UI toggle (declined by user).
- Treating mention as a distinct on-row badge (today it already drives the unread bold styling — bucket inclusion is enough).

## 10. Questions for Reviewer

1. **Field semantic narrow vs adding `myFailedAgentIds` / `myPendingQuestionAgentIds`** — design picks narrow (rationale §3.2). If reviewer prefers parallel "mine" fields (keeping the existing fields raw for some panel UI we don't yet have), say so before implementation.
2. **Mention as 3rd attention tier** — design adds `mention` to `ATTENTION_PRIORITY`. If you'd rather mention NOT sort *inside* the attention bucket (e.g. mention rows stay in their normal recency / source bucket but get a different visual cue), say so — that's a smaller frontend-only change but a different product feel.
3. **`busyAgentIds`** — design keeps it un-narrowed (a watcher seeing "someone is working" is informational, not attention). Confirm.
4. **Doc location** — placed under `docs/development/` to fit existing repo layout. If a `proposals/` directory is preferred (matches in-repo code-comment references like `proposals/chat-data-model-restructure.20260512.md` — those resolve in a sibling first-tree-context repo, not here), I'll move it.

---

On approval I'll convert this into a step-by-step implementation plan (`docs/superpowers/plans/2026-05-26-needs-attention-scoping.md`) following the `writing-plans` skill format, then execute.
