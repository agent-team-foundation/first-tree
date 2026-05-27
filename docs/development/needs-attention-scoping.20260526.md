# Needs-Attention Scoping — Technical Design (2026-05-27 rewrite)

> Status: **draft — three-rule simplification + NHA M1 data-source migration**
> Author: gandy-developer
> Supersedes: the four-rule (R1 mine-failed / R2 mine-pending / R3 speaker-fallback / R4 unread-mention) variant from the 2026-05-26 draft.

## 1. Problem & Locked Rules

The chat-first workspace pins a chat into the "Needs attention" bucket when *the chat points at me*. Prior iterations carried two systemic mistakes:

1. **Speaker-fallback R3 (any agent has a pending question + I'm a speaker → pin)** turned every group chat with any open agent question into noise for every other speaker, even when the question was clearly addressed to someone else.
2. **Unread-only R4 (unreadMentionCount > 0 → pin)** rode on the v1 1-on-1 implicit auto-mention (`services/message.ts:282 dmAutoProjection`), so every agent reply in a DM pinned the chat — but the user only cared about that signal as a red dot, not as a top-of-list anchor.

After alignment with the user, the predicate is collapsed to **three rules**, each gated on "is this chat *pointing at me*":

```
chat ∈ Needs Attention ⇔ any of:
  R1. agent ∈ chat has composite main = 'failed'    AND agent.manager = caller_member
  R2. ∃ message ∈ chat with created_at > caller.last_read_at  AND  caller_human_id ∈ message.metadata.mentions
  R3. ∃ attention ∈ chat with state = 'open'         AND  attention.target_human_id = caller_human_id
```

Sort ladder inside the bucket (unchanged): `failed > needs_you > mention`.

## 2. Data Sources

| Rule | Server field on `MeChatRow` | Backing store | Notes |
|------|-----------------------------|----------------|-------|
| R1   | `failedAgentIds: string[]`  | `agents.manager_id` × `agent_chat_status` | Manager-narrowed since #579. |
| R2   | `chatHasExplicitMentionToMe: boolean` | `messages.metadata.mentions` (JSONB array) × `chat_user_state.last_read_at` | `EXISTS (… WHERE m.metadata -> 'mentions' @> jsonb_build_array(caller_human_uuid))` in unread window. |
| R3   | `chatHasOpenAttentionForMe: boolean`  | NHA `attentions.target_human_id` × `attentions.state = 'open'` | `EXISTS (… WHERE a.target_human_id = caller_human_uuid)` on the chat. |

The legacy `pending_questions` table has no production writer (PR #578 removed the `format=question` chat-internal write path) and is retired by this change. The schema file (`packages/server/src/db/schema/pending-questions.ts`) and lifecycle helpers (`packages/server/src/services/questions.ts`) are deleted; a followup migration drops the table itself.

### 2.1 Why decouple from `unreadMentionCount`?

`unreadMentionCount` is an integer counter — information-lossy. A bump can come from an explicit `@<me>` (which *should* pin) or from the 1-on-1 implicit auto-mention (which *should not*). The counter alone cannot distinguish. The v1 red-dot contract — every DM message bumps the counter so the chat row renders bold + red dot — must **not** change (`packages/server/src/__tests__/direct-chat-auto-mention.test.ts` pins it). The new `chatHasExplicitMentionToMe` boolean is the clean signal for the bucket; the counter keeps driving the badge.

### 2.2 Why `attentions` over `pending_questions`?

The NHA M1 `attentions` table records the explicit `target_human_id` of every Attention raised, plus a clean `state` (`open`/`closed`) lifecycle. `pending_questions` never had a target column, so a pre-NHA "scope by target" rule would have had to reverse-engineer the target via `messages.metadata.mentions` of the question message — which is empty in the 1-on-1 implicit case (the user's痛点). With `attentions.target_human_id` available natively, R3's semantics are exact: a chat is in R3 iff there's an open Attention whose target is me.

## 3. Code Layout

### 3.1 Server

| File | Change |
|------|--------|
| `packages/shared/src/schemas/me-chat.ts` | Add `chatHasExplicitMentionToMe` + `chatHasOpenAttentionForMe` (both `z.boolean().default(false)`). Mark `pendingQuestionAgentIds` / `chatHasOpenQuestion` as `@deprecated` — server permanently emits `[]` / `false` for one release for skew compat. |
| `packages/server/src/services/me-chat.ts` | Drop the `pendingQuestionAgentIds` and `chatHasOpenQuestion` derivations. Add two correlated `EXISTS` subqueries in the main `listMeChats` SQL: one against `messages` for R2, one against `attentions` for R3. |
| `packages/server/src/services/agent-chat-status.ts` | Rename `derivePendingQuestions` → `deriveOpenAttentionAgents`; read from `attentions.state = 'open'` instead. Per-agent `needsYou` axis for the panel view stays target-agnostic (any open attention raised by this agent qualifies). |
| `packages/server/src/services/chat-archive.ts` | Replace the `NOT EXISTS (SELECT 1 FROM pending_questions …)` carve-outs in both sweep paths with the equivalent `NOT EXISTS … FROM attentions … state = 'open'`. |
| `packages/server/src/services/attention.ts` | New helpers `closeOpenAttentionsByChat(tx, chatId, reason)` and `closeOpenAttentionsByAgents(tx, agentIds, reason)`. They flip every matching open row to `state='closed' + cancelled=true + cancelled_reason=reason`. |
| `packages/server/src/services/session.ts` | The `evicted`-target archive path calls `closeOpenAttentionsByChat(...)` instead of `markSupersededByChat(...)`. |
| `packages/server/src/services/client.ts` | The client-claim unpin path calls `closeOpenAttentionsByAgents(...)` instead of `markSupersededByAgents(...)`. |
| `packages/server/src/services/questions.ts` | **Deleted.** |
| `packages/server/src/db/schema/pending-questions.ts` | **Deleted.** The DB table is left in place; a followup migration drops it. |
| `packages/server/scripts/m0-supersede-historical-pending-questions.mjs` | **Deleted.** One-shot NHA M0 cleanup, no longer relevant. |

### 3.2 Front-end

| File | Change |
|------|--------|
| `packages/web/src/pages/workspace/conversations/group-rows.ts` | `rowAttentionReason` rewritten for the three rules. `rowNeedsYou` now reflects R3 directly (no more "bucket position alone" carve-out). Every new bool checked with strict `=== true` for old-server / new-web skew safety. |
| `packages/web/src/pages/chat-row-avatar-preview.tsx` | Fixture builder updated to include the new bools; preview wires `needsYou` to `chatHasOpenAttentionForMe === true`. |

### 3.3 Tests

| File | Change |
|------|--------|
| `packages/server/src/__tests__/me-chat-attention.test.ts` | Rewrite to pin the three-rule projection end-to-end. Covers R1 (mine-failed) × {speaker, watcher, manager-narrowing}; R2 × {1v1 plain → off (user's t7), 1v1 explicit, group explicit, group @other, mark-read clears}; R3 × {1v1 raise, group target=me, group target=other, notification-only closed-on-create}; composite + deprecation guards. |
| `packages/server/src/__tests__/agent-chat-status.test.ts` | Drop `pendingQuestions` imports; insert raw rows into `attentions` for the two cases that exercise the "non-speaker agent has an open ask" path. |
| `packages/server/src/__tests__/chat-archive.test.ts` | `seedPendingQuestion` helper replaced with `seedAttention`. |
| `packages/web/src/pages/workspace/__tests__/group-rows.test.ts` | Predicate tests rewritten for the three rules. Added a "version skew" describe block that deletes the new bools off a row fixture and verifies R2/R3 silently degrade to off (R1 still fires). |

## 4. Wire Compat

Old web + new server: the deprecated `pendingQuestionAgentIds` / `chatHasOpenQuestion` keys keep being emitted (`[]` / `false`), so the old front-end's `r.pendingQuestionAgentIds.length > 0` checks stay defined and false. No crashes.

New web + old server: the new `chatHasExplicitMentionToMe` / `chatHasOpenAttentionForMe` keys are missing. The strict `=== true` check in `group-rows.ts` returns false for `undefined`, so R2/R3 silently degrade to off. R1 keeps firing. Conservative direction: under-pin, never over-pin.

A followup PR deletes the deprecated keys from the shared schema once enough releases have rolled out.

## 5. Migration & Rollout

- **No DB migration.** The `pending_questions` table is left in place; data is dormant. A followup migration drops it after a release-or-two of soak.
- **Deploy order**: server first, then web. The skew direction (under-pin) is safe in either order.
- **Rollback**: pure code revert. No data corruption risk.

## 6. v1 Red-Dot Contract — Preserved

The DM auto-mention path (`services/message.ts:282 dmAutoProjection`) is untouched. Every DM message still bumps `chat_user_state.unread_mention_count`, the red dot and bold title still light, and `direct-chat-auto-mention.test.ts` keeps passing without changes. Only the downstream consumer (`group-rows.ts:rowAttentionReason`) decouples from the counter; R2 reads `chatHasExplicitMentionToMe` instead.

## 7. Open follow-ups

- Migration to `DROP TABLE pending_questions` once a release of soak passes.
- Drop the deprecated `pendingQuestionAgentIds` / `chatHasOpenQuestion` wire fields entirely after one release.
- Possibly extend R2 to cover "human watcher explicitly @-mentioned" — today the watcher's `unread_mention_count` doesn't bump under the `applyAfterFanOut` speaker branch, so a `@<human-watcher>` in a group doesn't pin. Out of scope here; track separately.
