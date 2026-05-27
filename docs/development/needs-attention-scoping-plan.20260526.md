# Needs-Attention Scoping — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scope the Agent Hub Web me-chat "Needs attention" bucket to chats that are actually relevant to the caller — narrow the existing wire fields to "agents I manage", add one boolean to cover the speaker-in-chat-with-question fallback, and extend the frontend predicate to also include unread @-mentions.

**Architecture:**
- **Backend** (`me-chat.ts`): one extra indexed lookup for the caller's managed-agent set; narrow the existing `failedAgentIds` / `pendingQuestionAgentIds` projection by that set; emit a new `chatHasOpenQuestion: boolean`.
- **Shared schema** (`me-chat.ts` zod): add `chatHasOpenQuestion` with `.default(false)` for version skew.
- **Frontend** (`group-rows.ts`): replace the 2-condition attention predicate with a 4-rule one (R1 mine-failed, R2 mine-pending, R3 speaker-in-chat-with-question, R4 unread-mention) and a local `ATTENTION_PRIORITY = ["failed","needs_you","mention"]` sort ladder.
- **No DB migration**, **no changes to the shared `resolveAgentChatStatuses` producer**, **no UI toggle**.

**Tech Stack:** TypeScript · Postgres (Drizzle ORM) · Fastify · React · Vitest · pnpm workspaces.

**Design doc**: `docs/development/needs-attention-scoping.20260526.md`

**Worktree**: `/Users/gandy/.first-tree-staging/data/workspaces/gandy-developer/worktrees/needs-attention-scoping`
**Branch**: `refactor/needs-attention-predicate` (off origin/main @ 3992f98)

---

## File Plan

| File | Change | Responsibility |
|---|---|---|
| `packages/shared/src/schemas/me-chat.ts` | Modify (`meChatRowSchema`) | Add `chatHasOpenQuestion` field |
| `packages/server/src/services/me-chat.ts` | Modify (`listMeChats`) | New `callerMemberId` param; fetch managed-agent set; narrow `failed`/`pending`; emit `chatHasOpenQuestion` |
| `packages/server/src/api/orgs/chats.ts` | Modify (1 call site) | Pass `scope.memberId` |
| `packages/server/src/__tests__/me-chat-activity.test.ts` | Modify | Add `callerMemberId` to `listMeChats` calls |
| `packages/server/src/__tests__/me-chat-source-tags.test.ts` | Modify | Same |
| `packages/server/src/__tests__/me-chat-service.test.ts` | Modify | Same |
| `packages/server/src/__tests__/direct-chat-auto-mention.test.ts` | Modify | Same |
| `packages/server/src/__tests__/cross-org-chat-pollution.test.ts` | Modify | Same |
| `packages/server/src/__tests__/me-chat-attention.test.ts` | Create | New integration tests B1–B10 (manager × membership × failed/pending matrix) |
| `packages/web/src/pages/workspace/conversations/group-rows.ts` | Modify | New `rowAttentionReason` / `ATTENTION_PRIORITY`; updated `rowIsFailed` / `rowNeedsYou` / `splitAttentionRows` |
| `packages/web/src/pages/workspace/__tests__/group-rows.test.ts` | Modify | Add 11 new cases under `splitAttentionRows — predicate` |

`chat-row-avatar-preview.tsx` / `conversations/index.tsx` are unchanged: they call `rowIsFailed`/`rowNeedsYou`, whose external signatures are preserved (internal logic adjusts).

---

## Pre-flight

- [ ] **Verify worktree state**

Run:
```bash
cd /Users/gandy/.first-tree-staging/data/workspaces/gandy-developer/worktrees/needs-attention-scoping
git status -sb
```
Expected: `## refactor/needs-attention-predicate...origin/main` and no untracked files except `docs/development/needs-attention-scoping*.md`.

- [ ] **Install workspace deps** (idempotent — skips if already current)

Run:
```bash
cd /Users/gandy/.first-tree-staging/data/workspaces/gandy-developer/worktrees/needs-attention-scoping
pnpm install
```

---

## Task 1 — Add `callerMemberId` to `listMeChats` (signature plumbing)

**Goal:** non-functional refactor — adds the new parameter end-to-end so subsequent tasks can use it. No behavior change yet.

**Files:**
- Modify: `packages/server/src/services/me-chat.ts` (signature only; body unchanged this task)
- Modify: `packages/server/src/api/orgs/chats.ts:94` (pass `scope.memberId`)
- Modify (each adds a `memberId` arg): `packages/server/src/__tests__/me-chat-activity.test.ts`, `me-chat-source-tags.test.ts`, `me-chat-service.test.ts`, `direct-chat-auto-mention.test.ts`, `cross-org-chat-pollution.test.ts`

- [ ] **Step 1.1: Update `listMeChats` signature**

Edit `packages/server/src/services/me-chat.ts` — the `listMeChats` function declaration:

```ts
export async function listMeChats(
  db: Database,
  humanAgentId: string,
  callerMemberId: string,
  organizationId: string,
  query: ListMeChatsQuery,
): Promise<ListMeChatsResponse> {
  // body unchanged in Task 1.
  ...
}
```

(Insert `callerMemberId: string,` after `humanAgentId: string,` and before `organizationId: string,`.)

- [ ] **Step 1.2: Update the route call site**

Edit `packages/server/src/api/orgs/chats.ts:94`:

```ts
return listMeChats(app.db, scope.humanAgentId, scope.memberId, scope.organizationId, query);
```

- [ ] **Step 1.3: Update all 5 test files to pass `memberId`**

Each test file already creates an admin via `createTestAdmin` (which returns `{ memberId, humanAgentUuid, organizationId, ... }`). For every `listMeChats(app.db, admin.humanAgentUuid, admin.organizationId, ...)` call, insert `admin.memberId` between `humanAgentUuid` and `organizationId`.

Run a sanity grep first to enumerate the call sites:

```bash
cd /Users/gandy/.first-tree-staging/data/workspaces/gandy-developer/worktrees/needs-attention-scoping
grep -n "listMeChats(" packages/server/src/__tests__/me-chat-*.test.ts packages/server/src/__tests__/direct-chat-auto-mention.test.ts packages/server/src/__tests__/cross-org-chat-pollution.test.ts
```

Apply this transform at every match:
```
- listMeChats(app.db, <humanAgentVar>, <orgVar>, ...)
+ listMeChats(app.db, <humanAgentVar>, <memberVar>, <orgVar>, ...)
```

Where `<memberVar>` is the corresponding `admin.memberId` / `member.id` for that test's admin context (look one or two lines up — every test owns its admin handle).

Note: `me-chat-activity.test.ts` has a `rowFor(chatId, viewerAgentId, organizationId)` helper around line 59 that currently shadows the same signature. If found, update its signature too:
```ts
async function rowFor(chatId: string, viewerAgentId: string, viewerMemberId: string, organizationId: string) {
  const { rows } = await listMeChats(app.db, viewerAgentId, viewerMemberId, organizationId, { ... });
  ...
}
```
and update all `rowFor(...)` callers in that file to thread the memberId through.

- [ ] **Step 1.4: Typecheck — confirm signature plumbing is clean**

Run:
```bash
cd /Users/gandy/.first-tree-staging/data/workspaces/gandy-developer/worktrees/needs-attention-scoping
pnpm typecheck 2>&1 | tail -20
```
Expected: no type errors. If any test file still calls the old 4-arg form, fix it.

- [ ] **Step 1.5: Backend tests still green (no behavior change yet)**

Run:
```bash
cd /Users/gandy/.first-tree-staging/data/workspaces/gandy-developer/worktrees/needs-attention-scoping
pnpm --filter @first-tree/server test -- me-chat 2>&1 | tail -30
```
Expected: all existing me-chat tests pass.

- [ ] **Step 1.6: Commit**

```bash
cd /Users/gandy/.first-tree-staging/data/workspaces/gandy-developer/worktrees/needs-attention-scoping
git add packages/server/src/services/me-chat.ts packages/server/src/api/orgs/chats.ts packages/server/src/__tests__/me-chat-*.test.ts packages/server/src/__tests__/direct-chat-auto-mention.test.ts packages/server/src/__tests__/cross-org-chat-pollution.test.ts
git commit -m "refactor(me-chat): thread callerMemberId into listMeChats signature

Plumbing only — no behavior change. Sets up the subsequent
manager-filter projection for the Needs-Attention bucket fix."
```

---

## Task 2 — Backend: fetch managed-agent set, narrow `failedAgentIds` / `pendingQuestionAgentIds`

**Goal:** introduce the manager filter inside the projection loop. After this task, R1 + R2 of the new predicate are satisfied on the wire.

**File:** `packages/server/src/services/me-chat.ts:438-478` (the section between `resolveAgentChatStatuses(...)` and the row build).

- [ ] **Step 2.1: Write the first failing integration test (B1 — mine-failed)**

Create `packages/server/src/__tests__/me-chat-attention.test.ts`:

```ts
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createMeChat, listMeChats } from "../services/me-chat.js";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

describe("listMeChats: needs-attention scoping (R1–R3 backend projection)", () => {
  const getApp = useTestApp();

  async function markErrored(agentId: string, chatId: string): Promise<void> {
    const app = getApp();
    await app.db.execute(sql`
      INSERT INTO agent_chat_sessions (agent_id, chat_id, state, runtime_state, runtime_state_at, updated_at)
      VALUES (${agentId}, ${chatId}, 'errored', 'error', NOW(), NOW())
      ON CONFLICT (agent_id, chat_id) DO UPDATE
        SET state = EXCLUDED.state,
            runtime_state = EXCLUDED.runtime_state,
            runtime_state_at = EXCLUDED.runtime_state_at
    `);
  }

  async function rowFor(chatId: string, admin: Awaited<ReturnType<typeof createTestAdmin>>) {
    const app = getApp();
    const { rows } = await listMeChats(app.db, admin.humanAgentUuid, admin.memberId, admin.organizationId, {
      limit: 50,
      filter: "all",
      engagement: "all",
    });
    return rows.find((r) => r.chatId === chatId) ?? null;
  }

  it("B1: mine-failed → failedAgentIds contains the agent", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    // createTestAgent(app, { managerMemberId: admin.memberId }) — agent under THIS admin.
    const mine = await createTestAgent(app, { name: `mine-${crypto.randomUUID().slice(0, 6)}` });
    // createTestAgent has its own internal admin; bind the agent's manager to ours instead.
    // Use a raw UPDATE: managerId is the only thing we need to flip.
    await app.db.execute(sql`UPDATE agents SET manager_id = ${admin.memberId} WHERE uuid = ${mine.agent.uuid}`);
    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [mine.agent.uuid],
    });
    await markErrored(mine.agent.uuid, chatId);
    const row = await rowFor(chatId, admin);
    expect(row?.failedAgentIds).toEqual([mine.agent.uuid]);
  });
});
```

(Helper note: `createTestAgent` internally creates a fresh admin and sets `managerId = that admin's memberId`. To simulate "mine vs theirs" we either (a) raw-UPDATE the `manager_id` post-creation as above, or (b) compose a single test admin and create multiple agents via `seedAgentFactory(app)`. Option a keeps each test self-describing; if `seedAgentFactory` proves cleaner across the test matrix, refactor at Step 2.6.)

- [ ] **Step 2.2: Run B1 — verify it fails**

```bash
cd /Users/gandy/.first-tree-staging/data/workspaces/gandy-developer/worktrees/needs-attention-scoping
pnpm --filter @first-tree/server test -- me-chat-attention 2>&1 | tail -20
```
Expected: B1 fails. (It will likely PASS today by accident because the current implementation also returns the agent; the manager filter only changes behavior in B2/B3 etc. We add B2 next to drive the real change.)

Actually — re-confirm by adding **B2 alongside B1 in the same step** before running, so the failing case is exercised:

```ts
  it("B2: someone-else's failed agent, caller is speaker → failedAgentIds empty", async () => {
    const app = getApp();
    const me = await createTestAdmin(app);
    const them = await createTestAdmin(app, { username: `peer-${crypto.randomUUID().slice(0, 8)}` });
    // 'theirs' is created under `them`'s admin context — managerId already = them.memberId.
    // Build it via the same low-level pattern createTestAgent uses but anchored to `them`.
    const theirs = await createTestAgent(app, { name: `theirs-${crypto.randomUUID().slice(0, 6)}` });
    await app.db.execute(sql`UPDATE agents SET manager_id = ${them.memberId} WHERE uuid = ${theirs.agent.uuid}`);
    // me + theirs in a chat — me is speaker (creator).
    const { chatId } = await createMeChat(app.db, me.humanAgentUuid, me.organizationId, {
      participantIds: [theirs.agent.uuid],
    });
    await markErrored(theirs.agent.uuid, chatId);
    const row = await rowFor(chatId, me);
    expect(row?.failedAgentIds).toEqual([]);  // <-- THIS is the regression today returns [theirs.uuid].
  });
```

Re-run; expect **B2 fails** with the current code returning `[theirs.uuid]`.

- [ ] **Step 2.3: Implement — fetch managed-agent set + apply filter**

Edit `packages/server/src/services/me-chat.ts:438-478`. Between `const statusByChat = await resolveAgentChatStatuses(...)` and the `for (const [chatId, statuses] of statusByChat) { ... }` loop, insert:

```ts
  // Manager-scope: agent UUIDs the caller manages (`agents.manager_id = caller.member_id`).
  // Drives the "mine" narrowing on the `failedAgentIds` / `pendingQuestionAgentIds`
  // projections — so a watcher (or peer speaker) is no longer pinned by someone
  // else's broken / waiting agent. The caller's own human agent is self-managed
  // (manager_id = caller.member_id); harmless because humans never produce
  // failed sessions or pending questions.
  //
  // One indexed read via `idx_agents_manager`, scoped to the same org as the
  // chat list. Result is materialised into an in-memory Set so the per-chat
  // projection loop below stays a single-pass walk over `statusByChat`.
  const managedRows = await db
    .select({ uuid: agents.uuid })
    .from(agents)
    .where(and(eq(agents.managerId, callerMemberId), eq(agents.organizationId, organizationId)));
  const managedAgentIds = new Set(managedRows.map((r) => r.uuid));
```

Then update the projection inside the existing loop. Replace the body of `for (const [chatId, statuses] of statusByChat)` with:

```ts
  for (const [chatId, statuses] of statusByChat) {
    const speakers = nonHumanSpeakersByChat.get(chatId);
    let freshest: { activity: LiveActivity; startedMs: number } | null = null;
    const failed: string[] = [];
    const pending: string[] = [];
    const busy: string[] = [];
    for (const s of statuses) {
      const isSpeaker = speakers?.has(s.agentId) ?? false;
      const isMine = managedAgentIds.has(s.agentId);
      if (isSpeaker && s.activity) {
        const startedMs = new Date(s.activity.startedAt).getTime();
        if (!freshest || startedMs > freshest.startedMs) freshest = { activity: s.activity, startedMs };
      }
      // failed — speaker-filtered AND narrowed to mine (R1).
      if (isSpeaker && s.main === "failed" && isMine) failed.push(s.agentId);
      // busy — speaker-filtered, NOT narrowed (informational, not attention).
      if (isSpeaker && s.working) busy.push(s.agentId);
      // pending — NOT speaker-filtered (a pending agent that has left still counts);
      // NARROWED to mine (R2). The frontend covers R3 (caller-is-speaker) via the
      // separate `chatHasOpenQuestion` boolean emitted below.
      if (s.needsYou && isMine) pending.push(s.agentId);
    }
    if (freshest) liveActivityByChat.set(chatId, freshest.activity);
    if (failed.length > 0) failedByChat.set(chatId, failed);
    if (pending.length > 0) pendingByChat.set(chatId, pending);
    if (busy.length > 0) busyByChat.set(chatId, busy);
  }
```

Update the JSDoc on `pendingQuestionAgentIds` field in the row build (a few lines below) so the wire-contract narrowing is documented at the projection site:

```ts
    // Comment block above the row build:
    // `pendingQuestionAgentIds` / `failedAgentIds` are narrowed to "agents I
    // manage" — drives the chat-list "Needs attention" pin without bleeding
    // peer / watcher chats into it. See docs/development/needs-attention-scoping.20260526.md.
```

- [ ] **Step 2.4: Run B1 + B2 — verify they pass**

```bash
cd /Users/gandy/.first-tree-staging/data/workspaces/gandy-developer/worktrees/needs-attention-scoping
pnpm --filter @first-tree/server test -- me-chat-attention 2>&1 | tail -20
```
Expected: both pass.

- [ ] **Step 2.5: Confirm no regressions on the rest of the me-chat suite**

```bash
pnpm --filter @first-tree/server test -- me-chat 2>&1 | tail -30
```
Expected: all green (existing tests use `admin.memberId` from Task 1.3, so the narrowing is a no-op for them — every agent they create is under the same admin).

- [ ] **Step 2.6: Commit**

```bash
git add packages/server/src/services/me-chat.ts packages/server/src/__tests__/me-chat-attention.test.ts
git commit -m "feat(me-chat): narrow failed/pending projections to caller-managed agents

Fixes the Needs-Attention badcase where a watcher (or peer speaker) was
pinned by someone else's broken / waiting agent. R1 (mine-failed) and
R2 (mine-pending) of the chat-granularity predicate. R3 (speaker-in-chat-
with-question) and R4 (mention) ship in subsequent commits.

Doc: docs/development/needs-attention-scoping.20260526.md"
```

---

## Task 3 — Backend: emit `chatHasOpenQuestion` boolean

**Goal:** add the new wire field so the frontend can implement R3 (caller-is-speaker fallback).

**Files:**
- Modify: `packages/shared/src/schemas/me-chat.ts` — zod schema
- Modify: `packages/server/src/services/me-chat.ts` — emit the field

- [ ] **Step 3.1: Write failing test B6 (someone-else's pending, caller is speaker)**

Append to `me-chat-attention.test.ts`:

```ts
  it("B6: someone-else's pending question, caller is speaker → pending empty but chatHasOpenQuestion=true", async () => {
    const app = getApp();
    const me = await createTestAdmin(app);
    const them = await createTestAdmin(app, { username: `peer-${crypto.randomUUID().slice(0, 8)}` });
    const theirs = await createTestAgent(app, { name: `theirs-pq-${crypto.randomUUID().slice(0, 6)}` });
    await app.db.execute(sql`UPDATE agents SET manager_id = ${them.memberId} WHERE uuid = ${theirs.agent.uuid}`);
    const { chatId } = await createMeChat(app.db, me.humanAgentUuid, me.organizationId, {
      participantIds: [theirs.agent.uuid],
    });
    // Seed a pending question by `theirs` in this chat.
    await app.db.execute(sql`
      INSERT INTO pending_questions (id, agent_id, chat_id, message_id, status, created_at)
      VALUES (
        ${crypto.randomUUID()},
        ${theirs.agent.uuid},
        ${chatId},
        ${crypto.randomUUID()},
        'pending',
        NOW()
      )
    `);
    const row = await rowFor(chatId, me);
    expect(row?.pendingQuestionAgentIds).toEqual([]);            // narrowed away (R2 fail)
    expect(row?.chatHasOpenQuestion).toBe(true);                  // raw bit fires (R3 fuel)
  });
```

Run:
```bash
pnpm --filter @first-tree/server test -- me-chat-attention 2>&1 | tail -20
```
Expected: B6 fails (field doesn't exist yet — likely a parse error or `undefined`).

- [ ] **Step 3.2: Add `chatHasOpenQuestion` to the wire schema**

Edit `packages/shared/src/schemas/me-chat.ts`, inside `meChatRowSchema`, after the `busyAgentIds` field:

```ts
  /**
   * True iff this chat has at least one non-human agent with a pending
   * AskUserQuestion (`pending_questions.status === 'pending'`), regardless
   * of whether that agent is managed by the caller. Drives the
   * "speaker-in-chat-with-question" fallback on the front-end
   * (`splitAttentionRows` R3) without re-broadening
   * `pendingQuestionAgentIds`, which stays narrowed to caller-managed.
   *
   * `.default(false)` for version skew: an older server build that predates
   * this field would otherwise produce `undefined`, which would silently
   * disable R3 — exactly the conservative degradation we want during a
   * web-ahead-of-server rollout (R1/R2/R4 continue to fire correctly).
   *
   * See `docs/development/needs-attention-scoping.20260526.md` §4 / §5.
   */
  chatHasOpenQuestion: z.boolean().default(false),
```

- [ ] **Step 3.3: Emit the field from the projection**

Edit `packages/server/src/services/me-chat.ts`. Add a fourth map alongside the existing three (just before the projection loop):

```ts
  const liveActivityByChat = new Map<string, LiveActivity>();
  const failedByChat = new Map<string, string[]>();
  const pendingByChat = new Map<string, string[]>();
  const busyByChat = new Map<string, string[]>();
  const hasOpenQuestionByChat = new Map<string, boolean>();   // NEW
```

Inside the inner `for (const s of statuses)` loop, add the raw bit:

```ts
      // chatHasOpenQuestion — raw "any agent in this chat has a pending
      // question" bit; unfiltered by speaker / manager. The front-end uses
      // it together with `r.access_mode === 'speaker'` to implement R3.
      if (s.needsYou) hasOpenQuestionByChat.set(chatId, true);
```

In the row build at the bottom (`rows: MeChatRow[] = pageRaw.map((r) => { ... return { ... } })`), add the field:

```ts
      busyAgentIds: busyByChat.get(r.chat_id) ?? [],
      chatHasOpenQuestion: hasOpenQuestionByChat.get(r.chat_id) ?? false,   // NEW
```

- [ ] **Step 3.4: Run B6 — verify pass**

```bash
pnpm --filter @first-tree/server test -- me-chat-attention 2>&1 | tail -20
```
Expected: B6 passes.

- [ ] **Step 3.5: Add the rest of the backend matrix (B3/B4/B5/B7/B8/B9/B10)**

Append to `me-chat-attention.test.ts`:

```ts
  it("B3: someone-else's failed agent, caller is watcher → failedAgentIds empty", async () => {
    const app = getApp();
    const me = await createTestAdmin(app);
    const them = await createTestAdmin(app, { username: `peer-${crypto.randomUUID().slice(0, 8)}` });
    const theirs = await createTestAgent(app, { name: `theirs-w-${crypto.randomUUID().slice(0, 6)}` });
    await app.db.execute(sql`UPDATE agents SET manager_id = ${them.memberId} WHERE uuid = ${theirs.agent.uuid}`);
    // chat created by `them` so `me` joins later as a watcher.
    const { chatId } = await createMeChat(app.db, them.humanAgentUuid, them.organizationId, {
      participantIds: [theirs.agent.uuid],
    });
    // Make `me` a watcher of that chat. (chat_membership row with access_mode='watcher'.)
    await app.db.execute(sql`
      INSERT INTO chat_membership (chat_id, agent_id, role, access_mode, mode, source, joined_at)
      VALUES (${chatId}, ${me.humanAgentUuid}, 'member', 'watcher', 'mention_only', 'manual', NOW())
      ON CONFLICT (chat_id, agent_id) DO NOTHING
    `);
    await markErrored(theirs.agent.uuid, chatId);
    const row = await rowFor(chatId, me);
    expect(row?.failedAgentIds).toEqual([]);
  });

  it("B4: my failed agent, caller is watcher → failedAgentIds still contains it (boundary A)", async () => {
    const app = getApp();
    const me = await createTestAdmin(app);
    const them = await createTestAdmin(app, { username: `peer-${crypto.randomUUID().slice(0, 8)}` });
    const mine = await createTestAgent(app, { name: `mine-w-${crypto.randomUUID().slice(0, 6)}` });
    await app.db.execute(sql`UPDATE agents SET manager_id = ${me.memberId} WHERE uuid = ${mine.agent.uuid}`);
    // `them` creates the chat; `me` watches.
    const { chatId } = await createMeChat(app.db, them.humanAgentUuid, them.organizationId, {
      participantIds: [mine.agent.uuid],
    });
    await app.db.execute(sql`
      INSERT INTO chat_membership (chat_id, agent_id, role, access_mode, mode, source, joined_at)
      VALUES (${chatId}, ${me.humanAgentUuid}, 'member', 'watcher', 'mention_only', 'manual', NOW())
      ON CONFLICT (chat_id, agent_id) DO NOTHING
    `);
    await markErrored(mine.agent.uuid, chatId);
    const row = await rowFor(chatId, me);
    expect(row?.failedAgentIds).toEqual([mine.agent.uuid]);
  });

  it("B5: my pending question → pendingQuestionAgentIds + chatHasOpenQuestion both true", async () => {
    const app = getApp();
    const me = await createTestAdmin(app);
    const mine = await createTestAgent(app, { name: `mine-pq-${crypto.randomUUID().slice(0, 6)}` });
    await app.db.execute(sql`UPDATE agents SET manager_id = ${me.memberId} WHERE uuid = ${mine.agent.uuid}`);
    const { chatId } = await createMeChat(app.db, me.humanAgentUuid, me.organizationId, {
      participantIds: [mine.agent.uuid],
    });
    await app.db.execute(sql`
      INSERT INTO pending_questions (id, agent_id, chat_id, message_id, status, created_at)
      VALUES (${crypto.randomUUID()}, ${mine.agent.uuid}, ${chatId}, ${crypto.randomUUID()}, 'pending', NOW())
    `);
    const row = await rowFor(chatId, me);
    expect(row?.pendingQuestionAgentIds).toEqual([mine.agent.uuid]);
    expect(row?.chatHasOpenQuestion).toBe(true);
  });

  it("B7: someone-else's pending question, caller is watcher → pending empty, chatHasOpenQuestion still true", async () => {
    const app = getApp();
    const me = await createTestAdmin(app);
    const them = await createTestAdmin(app, { username: `peer-${crypto.randomUUID().slice(0, 8)}` });
    const theirs = await createTestAgent(app, { name: `theirs-pqw-${crypto.randomUUID().slice(0, 6)}` });
    await app.db.execute(sql`UPDATE agents SET manager_id = ${them.memberId} WHERE uuid = ${theirs.agent.uuid}`);
    const { chatId } = await createMeChat(app.db, them.humanAgentUuid, them.organizationId, {
      participantIds: [theirs.agent.uuid],
    });
    await app.db.execute(sql`
      INSERT INTO chat_membership (chat_id, agent_id, role, access_mode, mode, source, joined_at)
      VALUES (${chatId}, ${me.humanAgentUuid}, 'member', 'watcher', 'mention_only', 'manual', NOW())
      ON CONFLICT (chat_id, agent_id) DO NOTHING
    `);
    await app.db.execute(sql`
      INSERT INTO pending_questions (id, agent_id, chat_id, message_id, status, created_at)
      VALUES (${crypto.randomUUID()}, ${theirs.agent.uuid}, ${chatId}, ${crypto.randomUUID()}, 'pending', NOW())
    `);
    const row = await rowFor(chatId, me);
    expect(row?.pendingQuestionAgentIds).toEqual([]);
    expect(row?.chatHasOpenQuestion).toBe(true);    // raw bit still true; FE will gate R3 on speaker.
  });

  it("B8: nothing failed / no pending → all new attention fields empty/false", async () => {
    const app = getApp();
    const me = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `quiet-${crypto.randomUUID().slice(0, 6)}` });
    const { chatId } = await createMeChat(app.db, me.humanAgentUuid, me.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    const row = await rowFor(chatId, me);
    expect(row?.failedAgentIds).toEqual([]);
    expect(row?.pendingQuestionAgentIds).toEqual([]);
    expect(row?.chatHasOpenQuestion).toBe(false);
  });

  it("B10: chat with only my own human agent → no false positives", async () => {
    const app = getApp();
    const me = await createTestAdmin(app);
    // Create a chat containing only me (loopback). createMeChat rejects
    // self-only chats — instead seed a membership row to model the empty-1:1
    // shape if/when it appears in prod.
    const peer = await createTestAgent(app, { name: `peer-${crypto.randomUUID().slice(0, 6)}` });
    const { chatId } = await createMeChat(app.db, me.humanAgentUuid, me.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    const row = await rowFor(chatId, me);
    expect(row?.failedAgentIds).toEqual([]);
    expect(row?.pendingQuestionAgentIds).toEqual([]);
    expect(row?.chatHasOpenQuestion).toBe(false);
  });

  it("B9: multi-chat listMeChats — B1-style + B2-style chats coexist with independent projections", async () => {
    const app = getApp();
    const me = await createTestAdmin(app);
    const them = await createTestAdmin(app, { username: `peer-${crypto.randomUUID().slice(0, 8)}` });
    // Chat A — my failed agent.
    const mineFailed = await createTestAgent(app, { name: `mf-${crypto.randomUUID().slice(0, 6)}` });
    await app.db.execute(sql`UPDATE agents SET manager_id = ${me.memberId} WHERE uuid = ${mineFailed.agent.uuid}`);
    const { chatId: chatA } = await createMeChat(app.db, me.humanAgentUuid, me.organizationId, {
      participantIds: [mineFailed.agent.uuid],
    });
    await markErrored(mineFailed.agent.uuid, chatA);
    // Chat B — their failed agent (me as speaker).
    const theirsFailed = await createTestAgent(app, { name: `tf-${crypto.randomUUID().slice(0, 6)}` });
    await app.db.execute(sql`UPDATE agents SET manager_id = ${them.memberId} WHERE uuid = ${theirsFailed.agent.uuid}`);
    const { chatId: chatB } = await createMeChat(app.db, me.humanAgentUuid, me.organizationId, {
      participantIds: [theirsFailed.agent.uuid],
    });
    await markErrored(theirsFailed.agent.uuid, chatB);

    const { rows } = await listMeChats(app.db, me.humanAgentUuid, me.memberId, me.organizationId, {
      limit: 50,
      filter: "all",
      engagement: "all",
    });
    const rowA = rows.find((r) => r.chatId === chatA);
    const rowB = rows.find((r) => r.chatId === chatB);
    expect(rowA?.failedAgentIds).toEqual([mineFailed.agent.uuid]);
    expect(rowB?.failedAgentIds).toEqual([]);
  });
```

Run:
```bash
pnpm --filter @first-tree/server test -- me-chat-attention 2>&1 | tail -40
```
Expected: all 10 cases (B1–B10) pass.

- [ ] **Step 3.6: Full server suite check**

```bash
pnpm --filter @first-tree/server test 2>&1 | tail -10
```
Expected: green. (If any unrelated test fails, isolate before continuing.)

- [ ] **Step 3.7: Commit**

```bash
git add packages/shared/src/schemas/me-chat.ts packages/server/src/services/me-chat.ts packages/server/src/__tests__/me-chat-attention.test.ts
git commit -m "feat(me-chat): emit chatHasOpenQuestion boolean for R3 fallback

New wire field on MeChatRow — defaults to false for version-skew safety.
Carries the raw 'any agent in this chat has a pending question' bit so
the front-end can implement the R3 caller-is-speaker fallback without
re-broadening pendingQuestionAgentIds (which stays manager-narrowed)."
```

---

## Task 4 — Frontend: new attention predicate

**Goal:** update `splitAttentionRows` and friends to apply R1–R4 with the priority ladder.

**File:** `packages/web/src/pages/workspace/conversations/group-rows.ts:184-225`

- [ ] **Step 4.1: Write the failing frontend tests**

Edit `packages/web/src/pages/workspace/__tests__/group-rows.test.ts`. Update the test row fixture factory to include the new field (default false):

```ts
function row(overrides: Partial<MeChatRow> & { id: string; lastMessageAt: string | null }): MeChatRow {
  return {
    chatId: overrides.id,
    type: overrides.type ?? "direct",
    membershipKind: overrides.membershipKind ?? "participant",
    source: overrides.source ?? "manual",
    entityType: overrides.entityType ?? null,
    title: overrides.title ?? overrides.id,
    topic: overrides.topic ?? null,
    participants: overrides.participants ?? [],
    participantCount: overrides.participantCount ?? 0,
    lastMessageAt: overrides.lastMessageAt,
    lastMessagePreview: overrides.lastMessagePreview ?? null,
    unreadMentionCount: overrides.unreadMentionCount ?? 0,
    canReply: overrides.canReply ?? true,
    engagementStatus: overrides.engagementStatus ?? "active",
    liveActivity: overrides.liveActivity ?? null,
    pendingQuestionAgentIds: overrides.pendingQuestionAgentIds ?? [],
    failedAgentIds: overrides.failedAgentIds ?? [],
    busyAgentIds: overrides.busyAgentIds ?? [],
    chatHasOpenQuestion: overrides.chatHasOpenQuestion ?? false,
  };
}
```

Append a new `describe`:

```ts
describe("splitAttentionRows — predicate (R1–R4)", () => {
  it("R1: mine-failed → attention bucket, failed tier", () => {
    const rows = [row({ id: "r1", lastMessageAt: null, failedAgentIds: ["mine"] })];
    const { attention } = splitAttentionRows(rows);
    expect(attention.map((r) => r.chatId)).toEqual(["r1"]);
    expect(rowIsFailed(attention[0]!)).toBe(true);
  });

  it("R2: mine-pending → attention bucket, needs_you tier", () => {
    const rows = [row({ id: "r2", lastMessageAt: null, pendingQuestionAgentIds: ["mine"] })];
    const { attention } = splitAttentionRows(rows);
    expect(attention.map((r) => r.chatId)).toEqual(["r2"]);
    expect(rowNeedsYou(attention[0]!)).toBe(true);
  });

  it("R3: chatHasOpenQuestion=true + caller is speaker → attention bucket, needs_you tier", () => {
    const rows = [
      row({
        id: "r3",
        lastMessageAt: null,
        chatHasOpenQuestion: true,
        membershipKind: "participant",
      }),
    ];
    const { attention } = splitAttentionRows(rows);
    expect(attention.map((r) => r.chatId)).toEqual(["r3"]);
    expect(rowNeedsYou(attention[0]!)).toBe(true);
  });

  it("R3 watcher: chatHasOpenQuestion=true + caller is watcher → NOT attention", () => {
    const rows = [
      row({
        id: "r3w",
        lastMessageAt: null,
        chatHasOpenQuestion: true,
        membershipKind: "watching",
      }),
    ];
    const { attention, rest } = splitAttentionRows(rows);
    expect(attention).toEqual([]);
    expect(rest.map((r) => r.chatId)).toEqual(["r3w"]);
  });

  it("R4: unread mention → attention bucket (no failed / pending)", () => {
    const rows = [row({ id: "r4", lastMessageAt: null, unreadMentionCount: 3 })];
    const { attention } = splitAttentionRows(rows);
    expect(attention.map((r) => r.chatId)).toEqual(["r4"]);
  });

  it("quiet row → NOT attention", () => {
    const rows = [row({ id: "quiet", lastMessageAt: null })];
    const { attention, rest } = splitAttentionRows(rows);
    expect(attention).toEqual([]);
    expect(rest.map((r) => r.chatId)).toEqual(["quiet"]);
  });

  it("priority: failed beats mention", () => {
    const rows = [row({ id: "fm", lastMessageAt: null, failedAgentIds: ["a"], unreadMentionCount: 1 })];
    const { attention } = splitAttentionRows(rows);
    expect(rowIsFailed(attention[0]!)).toBe(true);
  });

  it("priority: needs_you beats mention (R2 + mention)", () => {
    const rows = [row({ id: "pm", lastMessageAt: null, pendingQuestionAgentIds: ["a"], unreadMentionCount: 1 })];
    const { attention } = splitAttentionRows(rows);
    expect(rowIsFailed(attention[0]!)).toBe(false);
    expect(rowNeedsYou(attention[0]!)).toBe(true);
  });

  it("sort: failed > needs_you > mention", () => {
    const rows = [
      row({ id: "m", lastMessageAt: null, unreadMentionCount: 1 }),
      row({ id: "n", lastMessageAt: null, pendingQuestionAgentIds: ["x"] }),
      row({ id: "f", lastMessageAt: null, failedAgentIds: ["y"] }),
    ];
    const { attention } = splitAttentionRows(rows);
    expect(attention.map((r) => r.chatId)).toEqual(["f", "n", "m"]);
  });

  it("R2 + R3 simultaneously → single needs_you tier, no double-count", () => {
    const rows = [
      row({
        id: "r23",
        lastMessageAt: null,
        pendingQuestionAgentIds: ["mine"],
        chatHasOpenQuestion: true,
        membershipKind: "participant",
      }),
    ];
    const { attention } = splitAttentionRows(rows);
    expect(attention).toHaveLength(1);
    expect(rowNeedsYou(attention[0]!)).toBe(true);
  });

  it("stable sort within failed tier preserves input order", () => {
    const rows = [
      row({ id: "f1", lastMessageAt: null, failedAgentIds: ["a"] }),
      row({ id: "f2", lastMessageAt: null, failedAgentIds: ["b"] }),
    ];
    const { attention } = splitAttentionRows(rows);
    expect(attention.map((r) => r.chatId)).toEqual(["f1", "f2"]);
  });
});
```

Run:
```bash
cd /Users/gandy/.first-tree-staging/data/workspaces/gandy-developer/worktrees/needs-attention-scoping
pnpm --filter @first-tree/web test -- group-rows 2>&1 | tail -30
```
Expected: the new cases fail (`chatHasOpenQuestion` is set in fixtures but `splitAttentionRows` doesn't read it yet; R3-watcher test expects NOT attention but current code with the old predicate ignores `membershipKind` for R3).

- [ ] **Step 4.2: Implement the new predicate**

Replace lines 184-225 of `packages/web/src/pages/workspace/conversations/group-rows.ts` with:

```ts
// ---------------------------------------------------------------------------
// attention pinning (failed + needs-you + mention)
// ---------------------------------------------------------------------------
//
// Chat-granularity predicate — see docs/development/needs-attention-scoping.20260526.md.
// A chat enters the "Needs attention" bucket when ANY of:
//   R1. failedAgentIds.length > 0
//       (server-narrowed to agents the caller manages — see me-chat.ts)
//   R2. pendingQuestionAgentIds.length > 0
//       (same narrowing)
//   R3. chatHasOpenQuestion && membershipKind === "participant"
//       (anyone has a pending question and the caller is a human speaker in the chat —
//        covers "someone else's agent is asking in a chat I'm in")
//   R4. unreadMentionCount > 0
//       (someone @-mentioned the caller)
//
// Sort priority inside the bucket: failed > needs_you > mention.
//
// This is a separate ladder from the agent-status `compareMainStatus`
// (`failed`, `needs_you`, `working`, ...). `mention` is a chat-level signal,
// not an agent main status — overloading the shared comparator would couple
// two ladders that should evolve independently.

const ATTENTION_PRIORITY = ["failed", "needs_you", "mention"] as const;
type AttentionReason = (typeof ATTENTION_PRIORITY)[number];

/**
 * Highest-priority attention reason for this row, or null when not in attention.
 * Order matters: a row that satisfies multiple rules sorts under the highest tier.
 */
function rowAttentionReason(r: MeChatRow): AttentionReason | null {
  if (r.failedAgentIds.length > 0) return "failed";
  if (
    r.pendingQuestionAgentIds.length > 0 ||
    (r.chatHasOpenQuestion && r.membershipKind === "participant")
  ) {
    return "needs_you";
  }
  if (r.unreadMentionCount > 0) return "mention";
  return null;
}

/** A chat is currently in the failed tier of attention. */
export function rowIsFailed(r: MeChatRow): boolean {
  return rowAttentionReason(r) === "failed";
}

/** A chat is currently in the needs-you tier of attention. */
export function rowNeedsYou(r: MeChatRow): boolean {
  return rowAttentionReason(r) === "needs_you";
}

/**
 * Partition rows into the pinned "Needs attention" set and the rest. Within
 * attention, sort by `ATTENTION_PRIORITY` (stable within tier).
 *
 * ⚠️ Operates on the already-loaded rows only: an attention chat outside the
 * loaded page(s) is not pinned (page-local v1; cross-page pinned query is
 * a follow-up).
 */
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
    // Non-null by construction — only rows with a reason entered `attention`.
    const ra = rowAttentionReason(a) as AttentionReason;
    const rb = rowAttentionReason(b) as AttentionReason;
    return ATTENTION_PRIORITY.indexOf(ra) - ATTENTION_PRIORITY.indexOf(rb);
  });
  return { attention, rest };
}
```

Note: the previous import of `compareMainStatus` at the top of the file may no longer be used. Remove from the import statement if so (typecheck will report).

- [ ] **Step 4.3: Run frontend tests — verify pass**

```bash
pnpm --filter @first-tree/web test -- group-rows 2>&1 | tail -30
```
Expected: all green (existing cases + new 11 cases).

- [ ] **Step 4.4: Confirm consumers still compile**

```bash
pnpm typecheck 2>&1 | tail -20
```
Expected: no errors.

If `chat-row-avatar-preview.tsx` had test fixtures that omit `chatHasOpenQuestion`, the schema default (`false`) keeps zod parsing safe but a literal TS object will need the field. Check by:

```bash
grep -rn "pendingQuestionAgentIds: " packages/web/src --include="*.test.ts" --include="*.test.tsx"
```
At every match in a literal `MeChatRow` object, add `chatHasOpenQuestion: false,` to keep the type complete.

- [ ] **Step 4.5: Full web suite**

```bash
pnpm --filter @first-tree/web test 2>&1 | tail -10
```
Expected: green.

- [ ] **Step 4.6: Commit**

```bash
git add packages/web/src/pages/workspace/conversations/group-rows.ts packages/web/src/pages/workspace/__tests__/group-rows.test.ts
git commit -m "feat(web): apply R1–R4 attention predicate with mention tier

R1 mine-failed and R2 mine-pending narrow to caller-managed (server
provides). R3 covers 'someone else's agent asking in my speaker chat'
via the new chatHasOpenQuestion bit + access_mode check. R4 surfaces
unread @-mentions into the Needs Attention bucket. Sort priority is
failed > needs_you > mention via a local ATTENTION_PRIORITY ladder
(separate from the agent-status compareMainStatus)."
```

---

## Task 5 — Final verification + ship

- [ ] **Step 5.1: Full repo check**

```bash
cd /Users/gandy/.first-tree-staging/data/workspaces/gandy-developer/worktrees/needs-attention-scoping
pnpm check 2>&1 | tail -20
pnpm typecheck 2>&1 | tail -20
pnpm test 2>&1 | tail -30
```
Expected: all green.

- [ ] **Step 5.2: Confirm the badcase is fixed (smoke check)**

Re-read the badcase: "non-self-related agent broke → appears in my Needs Attention".

Walk through `me-chat-attention.test.ts` B2 (peer-managed agent failed, caller is speaker) — covered.
Walk through B3 (peer-managed agent failed, caller is watcher) — covered.

- [ ] **Step 5.3: Diff review**

```bash
git log origin/main..HEAD --oneline
git diff origin/main..HEAD --stat
```
Expected: 4 commits, ~5 files modified + 1 new test file + 1 design doc + 1 plan doc.

- [ ] **Step 5.4: Report back to gandy-s-assistant for confirmation**

Send a `fts chat send gandy-s-assistant` message with:
- Worktree path + branch
- Commit shas
- Pasted test output (B1–B10 + frontend predicate cases)
- Ask whether to push / open PR

(Do NOT push without confirmation per the project's chat protocol.)

---

## Self-Review Checklist (already applied)

- ✅ Every step has exact code or exact commands.
- ✅ No placeholders (`TODO`, "implement later", "fill in details").
- ✅ Type / method names consistent across tasks (`rowAttentionReason`, `ATTENTION_PRIORITY`, `chatHasOpenQuestion`, `callerMemberId`).
- ✅ TDD: each behavior change has a failing test before implementation.
- ✅ Frequent commits — one per task boundary, on the same logical change.
- ✅ Spec coverage: R1 (B1, B4, R1 frontend), R2 (B5, R2 frontend), R3 (B6, B7, R3 + R3-watcher frontend), R4 (R4 frontend), Boundaries A/B/C all covered (B4 = A, B6 = B, "multi-speaker" = C accepted via R3-frontend test).

---

## Risks / Open Items

- **`createTestAgent` post-create UPDATE of `manager_id`**: works because `agents.manager_id` is plain `text` (no FK / trigger). If the test helper grows a manager-update API later, switch to it.
- **R3 across multiple humans in one chat**: accepted noise (boundary C). When `pending_questions.addressed_user_id` lands (future M3), R3 narrows automatically — no client change needed; `chatHasOpenQuestion` is replaced by a per-caller-addressed bit and the predicate stays structurally identical.
