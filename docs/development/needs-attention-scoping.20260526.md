# Needs-Attention Scoping — Technical Design (2026-05-27 rewrite — Phase 1)

> Status: **Phase 1 — narrow the mention rule to explicit `@<me>`. Independent of NHA.**
> Author: gandy-developer
> Supersedes: the original four-rule (R1 mine-failed / R2 mine-pending / R3 speaker-fallback / R4 unread-mention) variant from the 2026-05-26 draft.

## 1. Two products, one easily-confused name

The chat-list left-rail **"Needs attention"** bucket and the NHA chat-bottom **AttentionCard** primitive are two distinct products that happen to share the word "attention":

| Surface | Granularity | Owns the data | Drives |
|---|---|---|---|
| **Left-rail "Needs attention"** (this doc) | **Chat-granularity** — pins entire chats to the top of the list | Chat-level signals: `failedAgentIds`, `messages.metadata.mentions`, `unread_mention_count` | Triage: which chats do I need to look at right now |
| **Chat-bottom AttentionCard** (NHA) | **Per-record** — one Attention row → one card | `attentions` table (NHA M1) | Structured agent → human Q&A within a chat |

The two are conceptually independent. They may eventually compose (a future R3 can escalate an open NHA Attention into the chat-list bucket), but Phase 1 of this design keeps them strictly separated so the chat-list bucket does not depend on NHA's still-iterating infrastructure.

## 2. Phase 1 predicate

A chat enters the "Needs attention" bucket when **either**:

```
chat ∈ Needs Attention ⇔ any of:
  R1. agent ∈ chat has main = 'failed'  AND  agent.manager = caller
  R2. unreadMentionCount > 0  AND  ∃ message ∈ chat
        with created_at > caller.last_read_at  AND  caller_human_id ∈ message.metadata.mentions
```

Sort ladder inside the bucket: `failed > mention`.

The `needs_you` middle tier in `ATTENTION_PRIORITY` is intentionally retained as a forward-compatibility slot for Phase 2's R3 (open Attention targeting me). It currently has no predicate branch.

## 3. What changed vs. main (PR #579)

PR #579 (`d8f8bbd1 refactor(me-chat): scope "Needs attention" to caller-relevant chats`, on main today) landed a four-rule predicate. After PR #578 (`aafb2e6d refactor: remove chat-internal ask-user surface (NHA M0 prep)`) removed every production writer to `pending_questions`, two of those four rules (R2 mine-pending, R3 speaker-fallback) became dead code in production — the field always reads empty. The fourth rule (R4 `unreadMentionCount > 0`) over-fired because it rode on the v1 1-on-1 implicit DM auto-mention (`services/message.ts:282 dmAutoProjection`), pinning every DM reply.

Phase 1 collapses to two rules:

| Old | Phase 1 |
|---|---|
| R1 mine-failed (manager-narrowed) | **R1** unchanged. |
| R2 mine-pending (via `pending_questions`) | **Dropped.** Dead source post-#578. |
| R3 speaker-fallback (any open question + I'm speaker) | **Dropped.** Same dead source. |
| R4 `unreadMentionCount > 0` (any mention) | **R2** — narrowed to **explicit `@<me>`** via a new `chatHasExplicitMentionToMe` boolean. Closes the user's reported 1v1-DM-plain-final-message false positive. |

`pendingQuestionAgentIds` and `chatHasOpenQuestion` remain on the wire (deprecated, server emits empty/false naturally because their backing data is dormant); the front-end stops consuming them. A follow-up PR drops the fields entirely.

## 4. New wire field

```ts
// packages/shared/src/schemas/me-chat.ts
chatHasExplicitMentionToMe: z.boolean().default(false),
```

True iff there exists a message in the chat with `created_at > caller.last_read_at` AND `metadata.mentions` containing the caller's human-agent UUID.

Derived at query time via a correlated `EXISTS` on `messages`. No schema migration. Uses the existing `idx_messages_chat_time` for the chat+window scan.

`.default(false)` for version skew; the front-end uses strict `=== true` (the web client doesn't run rows through `meChatRowSchema.parse`, so `.default(false)` only applies server-side).

## 5. v1 red-dot contract — preserved

`dmAutoProjection` is unchanged. `unread_mention_count` still bumps on every DM and still drives the red dot + bold row title. Only the bucket predicate decouples from the raw counter; the new `chatHasExplicitMentionToMe` is an additional signal on top, not a replacement.

`direct-chat-auto-mention.test.ts` continues to pass unchanged.

## 6. User scenarios verified

| Scenario | Result |
|---|---|
| 1v1, agent → me plain "ack" final message (the original pain point) | counter bumps (red dot stays), `chatHasExplicitMentionToMe=false` → **NOT** in attention |
| 1v1, agent → me with explicit `@<me>` in the message | counter bumps, `chatHasExplicitMentionToMe=true` → **IN** attention (mention tier) |
| Group, my managed agent fails in this chat | `failedAgentIds=[mine]` → **IN** attention (failed tier) |
| Group, peer agent fails in this chat | `failedAgentIds=[]` (manager-narrowed) → **NOT** in attention |
| Group, any agent `@<me>` in unread | `chatHasExplicitMentionToMe=true` → **IN** attention (mention tier) |
| Group, any agent `@<peer>` (not me) | `chatHasExplicitMentionToMe=false` → **NOT** in attention |
| Mark-read | `last_read_at` advances past mentioning message → `chatHasExplicitMentionToMe=false` |

## 7. Phase 2 — open question targeting me, via NHA

When the NHA `attentions` infrastructure stabilises (per @yuezengwu's review note on the closed Phase 0 PR), this design will be extended with:

```
  R3. ∃ attention ∈ chat with state = 'open' AND target_human_id = caller
```

— served by a new `chatHasOpenAttentionForMe` boolean derived from an `EXISTS` on `attentions`. Rationale: when an agent raises a structured NHA Attention targeting me but does **not** also send a chat message with `@<me>` (the message is optional in NHA's design), the chat needs to bubble up to the left-rail bucket — the chat-bottom AttentionCard alone is not a global enough surface to ensure discovery. This is the **escalation contract** between the two products.

Phase 2 will land as a separate, smaller PR once NHA is on main. It will reuse the `needs_you` ladder tier already reserved in `ATTENTION_PRIORITY`.

## 8. Roll-out

- **No DB migration.**
- **Deploy order**: server first (emits new field), then web (consumes it).
- **Skew direction**: under-pin, never over-pin. New web + old server → `chatHasExplicitMentionToMe` undefined → strict `=== true` returns false → mention rule degrades to off, R1 keeps firing.
- **Rollback**: pure code revert. No data corruption risk.

## 9. Followups

1. Drop the deprecated `pendingQuestionAgentIds` / `chatHasOpenQuestion` wire fields after one release.
2. Phase 2: add `chatHasOpenAttentionForMe` once NHA `attentions` lands on main.
3. Possibly extend R2 to cover "human watcher explicitly `@`-mentioned" — currently the watcher's `unread_mention_count` doesn't bump under `applyAfterFanOut`'s speaker branch, so a `@<human-watcher>` in a group doesn't pin. Tracked separately.
