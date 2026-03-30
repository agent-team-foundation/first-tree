---
title: "Messaging System"
owners: [baixiaohang, yuezengwu]
soft_links: [/members, agent-hub/client-runtime.md]
---

# Messaging System

The messaging system is the core of Agent Hub — not just IM, but infrastructure for async agent collaboration with task context preservation.

---

## Why Not Just Use Feishu/Slack?

Three hard constraints make existing IM platforms insufficient:

1. **Bot-to-bot doesn't work.** Feishu/Slack natively do not support bot-to-bot messaging. Two agents have no channel to collaborate.
2. **No task context.** IM platforms deliver messages but don't track execution context across conversations. An agent that needs another agent's help mid-task has no way to resume.
3. **Platform lock-in.** Building all communication logic on Feishu means rewriting everything for Slack.

Feishu/Slack are not replaced — they remain the human interface. Adapters bridge them. The messaging system is the agent-to-agent communication backbone.

---

## Core Concepts

### Chat

Communication container — a unified abstraction for DMs, group chats, and threads. All share the same data model.

- **Direct:** Two participants (agent-to-agent or agent-to-human).
- **Group:** N participants. Agents can participate in `full` or `mention_only` mode.

### Message

Basic communication unit. Format and semantics are separated:

- **Format** defines structure: `text`, `markdown`, `card`. The system knows how to render them.
- **Semantics** are application-defined via open `metadata` field. A card can be an approval request, a notification, or a survey — same format, different meaning.
- **UUID v7** as Message ID — time-ordered and globally unique. Messages are immutable after creation.

### Inbox

Each agent has one Inbox — the single entry point for all inbound messages across all Chats.

- Server writes to Inbox via **fan-out on write**: when a message is sent, an InboxEntry is created for each participant (except the sender).
- `InboxEntry.chat_id` is a routing label that may differ from `message.chat_id` in replyTo scenarios.
- **At-least-once delivery**: Server uses ACK + timeout + retry. Client is responsible for deduplication (FIFO deduplicator with capacity 1000).

### Session (Agent Runtime concept)

`(Agent + Chat) = 1 Session`. The Client Runtime routes Inbox entries to the correct Session by `chat_id`. For Session lifecycle, state management, and persistence design, see [client-runtime.md](client-runtime.md).

---

## Cross-Chat replyTo

The key capability beyond standard IM: a message's `reply_to` field can point to **(inbox, chat)** — routing the reply to a different Chat's context.

### How It Works

Agent A is handling a task in Chat_X (with a human). It needs Agent B's approval:

1. Agent A sends a message to Agent B with `reply_to = { inbox: Agent_A, chat: Chat_X }`.
2. Agent B processes and replies with `in_reply_to = original_message_id`.
3. Server routes the reply to Agent A's Inbox, tagged with `chat_id = Chat_X`.
4. Agent A's Runtime delivers it to the Session for Chat_X — task context is preserved.

The messaging system only handles concepts it knows (Inbox, Chat, Message). It does not need to know about Sessions.

### Two Communication Modes

**Conversational:** Ongoing interaction in a Chat (human ↔ agent). Messages flow through Chat → Inbox → Session. Session persists for continuity.

**Transactional (Request-Response):** Agent-to-agent task collaboration using replyTo. Inspired by Actor Model's Ask pattern. The reply is routed back to the originator's context.

Both modes are built on the same Chat + Message primitives. The difference is the reply routing path.

---

## Message Flow Example

```
Human says in Feishu: "Update /backend/api.md docs"

  ①  Feishu Adapter converts → Message in Chat_X (Human ↔ Agent A)
  ②  Fan-out → Agent A's Inbox
  ③  No active Session for Chat_X → create Session #1
  ④  Session #1 processes:
      ├── Loads Context Tree → owner is Agent B
      ├── Sends approval request to Agent B, reply_to = (Agent_A_Inbox, Chat_X)
      └── Replies to Human: "Approval requested, waiting..."

  ⑤  Agent B's Inbox receives → Session #2 → approves → replies "Approved"
  ⑥  Reply routed via replyTo → Agent A's Inbox, tagged Chat_X
      → Runtime routes to Session #1
  ⑦  Session #1 continues → updates docs → replies "Done"

Human says: "Also fix the return format"

  ⑧  Same Chat_X → existing Session #1 → full context preserved → understands "the" refers to the API
```

---

## Data Model

Four tables implement the messaging concepts:

| Table | Represents |
|-------|------------|
| `chats` | Communication containers — unified abstraction for DMs and groups |
| `chat_participants` | Which agents belong to which Chat, and their participation mode |
| `messages` | Immutable message records, time-ordered by UUID v7 |
| `inbox_entries` | Per-recipient delivery queue; the fan-out result with routing label for replyTo |
