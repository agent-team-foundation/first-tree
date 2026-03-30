---
title: "IM Adapter Architecture"
owners: [baixiaohang]
soft_links: [/members]
---

# IM Adapter Architecture

The Adapter layer bridges internal Chats with external IM platforms (Feishu, Slack). It is a pure service component — it does not create agents, generate tokens, or participate in chats.

---

## Design Principles

| Principle | Description |
|-----------|-------------|
| **Agent is the only identity** | No "Feishu agent" or "Slack agent". An agent is an agent; platforms are just communication channels. |
| **Adapter is a service, not an agent** | Adapter bridges messages. It does not appear in the agent list, does not have its own inbox. |
| **1:1 Agent ↔ Bot** | Each non-human agent binds to one independent Bot per platform, with its own identity and avatar. |
| **Human identity unified across platforms** | The same person on Feishu and Slack maps to the same Human Agent. |
| **Agent lifecycle decoupled from platform binding** | Agent creation/deletion is independent of IM platform binding. |

---

## Identity Model

### Non-Human Agents — Outbound Identity

Each non-human agent binds to a Bot per platform via `adapter_configs`:

```
xx-agent       ↔  Feishu Bot A (cli_xxx)
               ↔  Slack Bot B (xapp_xxx)

code-reviewer  ↔  Feishu Bot C (cli_yyy)
```

Constraint: `UNIQUE(agent_id, platform)` — one agent, one Bot per platform.

On Feishu, different agents' messages appear as different Bots with distinct names and avatars — true 1:1 identity.

### Human Agents — Inbound Identity

Human agents' external identities are mapped via `adapter_agent_mappings`:

```
feishu  │  ou_96274fa8...  →  zhangsan
slack   │  U_ABC123        →  zhangsan
feishu  │  ou_1234abcd...  →  john
```

The same person across platforms maps to a single Human Agent. All conversation history is unified.

### Unknown Users

When an unmapped user sends a message, the Bot replies with a binding prompt containing their platform user ID. The message is **not** written to the internal system. An admin must manually create the binding via the Web console or Admin API.

---

## Message Flow

### Inbound (External Platform → Agent Hub)

```
Feishu user zhangsan messages Bot A
    │
    ↓  Feishu WSClient receives im.message.receive_v1
    ↓  Deduplicate (processed_events table, event_id unique)
    ↓  Identity: adapter_agent_mappings(feishu, ou_xxx) → zhangsan
    ↓  Chat: adapter_chat_mappings lookup → reuse or create Chat
    ↓       Participants = [zhangsan, xx-agent] (from adapter_configs.agentId)
    ↓  Write message: sendMessage(chatId, senderId=zhangsan)
    ↓  Fan-out → xx-agent's inbox receives the message
    ↓  Store reference: adapter_message_references(messageId ↔ external_message_id)
```

### Outbound (Agent Hub → External Platform)

```
xx-agent sends message in Chat
    │
    ↓  Fan-out → zhangsan's inbox receives the message
    ↓  Adapter outbound service claims inbox entries for Feishu-bound agents
    ↓  Skip if metadata.source = 'feishu' (already on Feishu side)
    ↓  Find external channel via adapter_chat_mappings
    ↓  Find Bot credentials via adapter_configs
    ↓  Format conversion (markdown → interactive card, etc.)
    ↓  Send via Feishu API
    ↓  ACK inbox entry + store message reference
```

---

## Data Model

Four adapter tables with clear separation of concerns:

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `adapter_configs` | Bot credentials (outbound identity) | platform, agent_id, credentials (AES-256-GCM encrypted) |
| `adapter_agent_mappings` | User mapping (inbound identity) | platform, external_user_id, agent_id, bound_via |
| `adapter_chat_mappings` | Chat ↔ external channel routing | platform, external_channel_id, chat_id |
| `adapter_message_references` | Message ID mapping (for edits/references) | message_id, external_message_id |

---

## Binding

### Bot Credentials (Non-Human Agents)

Managed by admin in the Web console:

```
Admin selects Agent → selects platform → enters Bot credentials → save
  → adapter_configs written
  → WebSocket connection auto-starts
```

Bot creation on IM platforms is manual (no platform provides a "create app" API). Admin creates the app in the platform's developer console, then enters credentials in Agent Hub.

### User Mapping (Human Agents)

Currently: **manual binding only**. Admin creates a mapping in the Web console or via `POST /admin/adapter-mappings`.

Flow: Admin creates Human Agent → user tries messaging Bot → Bot replies with user ID → user sends ID to admin → admin creates binding.

---

## Layered Architecture

```
Agent Data Source       Replaceable: Admin API → Context Tree → external IdP
────────────────────
Agent Hub Core          Stable: agents, chats, inbox, messages
────────────────────
Adapter Layer           Extensible: Feishu → Slack → Discord → ...
```

Each layer evolves independently. Adding a platform means implementing an Adapter, not touching the core. Changing the agent data source means touching the top layer, not the Adapter.
