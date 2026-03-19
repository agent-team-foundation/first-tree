---
title: IM Channels
owners: [Gandy2025]
---

# IM Channels

Kael can connect third-party IM platforms such as Feishu so users can talk to the same agent session from web and chat apps.

## Core Model

- IM integrations should not change the core agent execution pipeline.
- A channel adapter layer normalizes inbound messages, formats outbound messages, and manages external-user mapping.
- The integration touches the core system through the existing message publish/subscribe boundary rather than a parallel execution path.

## Product Decisions

- Web and IM should stay synchronized around the same underlying session when possible.
- Identity binding happens only in bot private chat. Group chat usage depends on at least one bound user.
- Group chats share one session and project binding so the collaboration unit is the chat thread, not each individual participant.
- Group chats currently default to `mention_only` reply behavior, with a per-chat override path to `always`.
- Outbound delivery defaults to final-result messages rather than post-and-edit pseudo-streaming because frequent message edits are a poor fit for IM platform limits and agent tool execution.

## Binding Model

- Verification and user mapping are separate concerns. New verification methods should funnel into the same mapping write path.
- Private chats bind to the latest suitable session or create one if none exists.
- Group chats create or reuse a shared project/session binding after a bound user activates the bot.

## Operational Constraints

- The first version uses in-memory deduplication and binding-code storage because deployment is single-instance.
- Multi-instance deployment will require shared state such as Redis.
- Channel binding records intentionally avoid deep coupling to core tables so the IM layer can evolve independently.

## Cross-Domain Links

- Workspace durability and container semantics: [../workspace.md](../workspace.md)
- User interaction patterns that the IM session mirrors: [../../chat/NODE.md](../../chat/NODE.md)
