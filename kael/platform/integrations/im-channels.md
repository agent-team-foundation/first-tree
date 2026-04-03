---
title: IM Channels
owners: [Gandy2025]
soft_links: [/kael/platform/workspace.md, /kael/chat/NODE.md]
---

# IM Channels

Kael can connect third-party IM platforms such as Feishu so users can talk to the same agent session from web and chat apps.

## Core Model

- IM integrations should not change the core agent execution pipeline.
- A channel adapter layer normalizes inbound messages, formats outbound messages, and manages external-user mapping.
- The integration touches the core system through a publish hook on `MemoryEventBus`, not a parallel execution path.
- The adapter runs in-process inside the FastAPI backend — not as a separate service. This was chosen because the IM layer needs tight integration with `AgentTaskManager` and `MemoryEventBus` for message injection and event delivery.

## Adapter Architecture

A platform-agnostic `ChannelAdapter` ABC defines the contract: inbound (`verify_webhook`, `parse_event`), outbound (`send_text`, `send_card`, `edit_message`), and identity (`resolve_user`). Platform-agnostic types (`InboundEvent`, `ChannelTarget`, `ChannelUser`, `DeliveryResult`) ensure no platform-specific types leak into the core pipeline.

A singleton `ChannelAdapterRegistry` maps platform IDs to adapter instances. Adapters self-register at app startup.

One adapter instance manages **all bots** for its platform (e.g., a single `FeishuAdapter` manages multiple Feishu bots). This simplifies the registry but increases adapter complexity — per-bot token caching and `asyncio.Lock` on bot mutations are handled within the adapter. Bots can be hot-loaded at runtime (`add_bot`, `remove_bot`) without restart.

`ChannelCapabilities` declares what each platform supports (cards, threads, reactions, streaming cards), allowing the outbound pipeline to adapt delivery format per-platform.

## Bot = Agent = Kael Account

A bot on any IM platform is a Kael Account. There is no distinction at the data model level between a "personal" bot and a "public" bot — both follow the same binding and routing model.

- **Personal Bot**: A user creates a bot via device auth → the bot is bound to the user's Kael Account and project.
- **Public Bot**: An independent virtual employee (e.g., "company finance agent") → the bot IS its own Kael Account with its own project.
- Multiple public bots per org = multiple virtual employees, each with their own account, project, and cross-session memory.

The routing logic is identical: **bot → Kael Account → project → session**.

## Binding Model

Three database tables form the identity and routing layer. None have foreign keys to core tables (users, sessions, projects) — deliberately decoupled so the IM layer can evolve independently.

### User Mapping (platform user ↔ Kael user)

`ChannelUserMapping` maps a platform user identity to a Kael user. Key fields: `platform`, `platform_user_id`, `kael_user_id`, `bot_id`, `bound_via`. Unique on `(platform, platform_user_id)`.

For per-user bots, this lookup is skipped entirely — the user is resolved directly from `feishu_bot_registrations.user_id`.

### Chat Binding (chat ↔ session)

`ChannelBinding` maps a platform conversation to a Kael session+project. Key fields: `platform`, `channel_id`, `thread_id`, `session_id`, `project_id`, `bot_id`. Unique on `(platform, channel_id, thread_id)`. Supports `upsert()` for concurrent safety.

When a new chat is seen for the first time, a session is auto-created — no manual `/bind` needed:
- **DM**: Auto-binds to the user's most recently updated project's latest session.
- **Group chat**: Auto-creates a new project (named from the group's chat title) with a new session.

### Bot Registration (per-user bot credentials)

`FeishuBotRegistrations` stores user-registered bot credentials. Credentials are Fernet-encrypted (reusing the existing `oauth_encryption_key`). Validated against the Feishu API before storing. One active bot per user.

Two connection modes: **webhook** (bot receives events via HTTP POST) and **websocket** (bot maintains a long connection via lark SDK's WSClient, running in a per-bot daemon thread with its own event loop).

```
Bot (Kael Account)
  └── Project
        ├── Session A  ←  DM with User X
        ├── Session B  ←  Group "Engineering"
        └── Session C  ←  Group "Finance"
```

### Routing

```
inbound message → bot_id → ChannelUserMapping → kael_user_id + project_id
                → chat_id → ChannelBinding → session_id
                → if no binding → auto-create session + binding
```

## Identity Binding Flows

### Forward Binding (Feishu → Web)

Unbound user sends a message in Feishu → system generates a 4-char alphanumeric code (ambiguous chars excluded: 0, O, 1, I, L) → user enters code on the Web UI → `ChannelUserMapping` created.

### Reverse Binding (Web → Feishu)

User clicks "Connect Feishu" on Web → system generates a `K-XXXX` prefixed token (distinct prefix prevents collision with forward codes) + Feishu AppLink URL → user opens link and sends `K-XXXX` to bot → `ChannelUserMapping` created.

### Device Auth (Per-User Bot)

User scans a QR code that initiates Feishu's Device Authorization flow (`accounts.feishu.cn/oauth/v1/app/registration`) → enters `app_id` + `app_secret` → credentials validated and stored → bot hot-loaded into the running adapter.

**Why verification codes, not OAuth?** IM in-app browsers have cookie isolation that breaks OAuth redirect flows. Verification codes work across all clients.

## Message Pipeline

### Inbound

```
webhook/websocket → parse_event → dedup → user mapping → command parsing → session lookup → inject
```

1. Adapter parses platform payload into `InboundEvent`
2. In-memory deduplication (5-min TTL) prevents double-processing
3. User mapping lookup (or per-user bot shortcut)
4. Slash command interception (`/switch`, `/group_mode`, `/status`, `/help`)
5. Session binding lookup (or auto-bind)
6. Content converters transform platform-native message formats into AI-friendly text
7. Message injected into agent pipeline via `AgentTaskManager.publish()`

A per-chat **serial queue** (FIFO) ensures messages for the same conversation are processed sequentially — prevents race conditions in binding/session lookup when messages arrive rapidly.

### Outbound

A single `on_event_published()` hook registered on `MemoryEventBus` fires on every event, regardless of whether the message originated from Web or IM. This replaced an earlier subscriber-per-session model that only delivered events when the session was initiated from IM.

The hook checks if the session has an active channel binding. If so, it formats the agent's response and delivers it via the adapter.

Outbound formatting:
- **Markdown detection**: Heuristic regex checks for headings, bold, italic, lists, code blocks. Markdown routes through `send_card()` (Feishu interactive card), plain text through `send_text()`.
- **Text chunking**: Long messages split at platform's `max_text_length`, preserving fenced code block markers.
- **Streaming cards**: CardKit 2.0 state machine (`IDLE → CREATING → STREAMING → COMPLETED/ABORTED`) with 300ms throttled flush for typewriter effect. Content streamed to a single markdown element.

## Content Processing

### Converters

A registry maps 16 Feishu message types to converter functions. Each returns an AI-friendly text representation plus a list of media resource descriptors. The registry pattern allows adding new message types without modifying core code.

### Channel Envelope

Inbound IM messages are wrapped in a YAML-style envelope before injection into the agent pipeline. The envelope provides structured metadata without modifying the message content.

Group chat example:
```
time: 2026-03-18 10:30:00 UTC
ch: feishu
chat: group "Engineering" oc_abc123
members: "Alice" ou_xxx, "Bob" ou_yyy
from: "Alice" ou_xxx
mid: om_msg123
ref: @bot, reply om_msg100
attach: image img_key1, file report.pdf
```

DM example:
```
time: 2026-03-18 10:30:00 UTC
ch: feishu
chat: dm oc_xyz789
from: "Alice" ou_xxx
mid: om_msg456
```

4-layer structure (stable → variable):
- **System**: `time` — when
- **Channel**: `ch` — platform only (`feishu`)
- **Chat**: `chat` — type + conversation ID (`group "Name" oc_xxx` or `dm oc_xxx`); `members` — speakers in history window (group only)
- **Message**: `from`, `mid`, `type`, `ref`, `attach` — who sent what

Design decisions:
- Chat type (group/dm) lives in `chat:`, not `ch:` — keeps platform and conversation concerns separate
- DM includes `chat_id` and `from:` — the agent cannot access session binding tables, so it needs these to know who it's talking to and to call platform tools
- `members:` lists speakers from the recent history window, not the full group member list — groups can have hundreds of members, and the agent only needs context about active participants
- `type` omitted for plain text (most common case)
- `ref` merges @bot mentions, reply references, and @user mentions into one field; absent when none exist
- Names are quoted to handle spaces: `"Name" id`
- Name precedes ID (matches natural reading order)

### Group Chat History

When the bot is @mentioned in a group, recent context is prepended as `<history>` with `name time: content` per line. Two mechanisms provide this:

1. **API fetch**: Newest 50 messages from the platform, cut at the previous @bot mention. Bot's own messages filtered by both `open_id` and `app_id`.
2. **In-memory accumulator**: Fallback when API fails. Records non-@mention messages per group, flushes on next @mention.

## Product Decisions

- Web and IM stay synchronized around the same underlying session.
- Group chats share one session and project binding — the collaboration unit is the chat thread, not each individual participant.
- Group chats default to `mention_only` reply behavior, with a per-chat override path to `always`.
- Outbound delivery defaults to final-result messages. Streaming cards (CardKit 2.0) are used where the platform supports them.

## Operational Constraints

- In-memory deduplication and binding-code storage because deployment is single-instance. Multi-instance requires shared state (Redis).
- No foreign keys between channel tables and core tables (users, sessions, projects) — the IM layer can evolve independently.
- Per-bot WebSocket connections run in daemon threads with dedicated event loops, bridging events to the main asyncio loop via `run_coroutine_threadsafe`.
- Streaming card flush throttled at 300ms to avoid platform API rate limits.

## Cross-Domain Touches

- **Agent runtime**: `MemoryEventBus.register_on_publish()` and `AgentTaskManager.register_on_publish()` — hook APIs added to core event bus for outbound delivery.
- **Session/Project**: Group chat auto-bind creates projects and sessions from the channel layer (`project_service.create_project()`, `session_repository.find_latest_non_subtask_session()`).
- **Auth/Crypto**: Bot credential encryption reuses `oauth_encryption_key` (Fernet). Device auth uses a separate flow (`accounts.feishu.cn`) outside the normal OAuth stack.
- **Workspace**: [../workspace.md](../workspace.md)
- **Chat patterns**: [../../chat/NODE.md](../../chat/NODE.md)
