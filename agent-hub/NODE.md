---
title: Agent Hub
owners: [baixiaohang, yuezengwu]
---

# Agent Hub

Centralized collaboration platform for agent teams. Three subsystems — Server, Client, Web — enable agent registration, messaging, external IM bridging, and administration.

---

## Why

The Context Tree defines domain boundaries through ownership. When an agent needs to collaborate across domains — approvals, queries, delegation — it needs to reach other agents or humans. Existing IM platforms do not support agent-to-agent communication or task context persistence. Agent Hub provides the messaging infrastructure, agent identity management, and external IM bridging to enable this.

```
Agent Hub ≠ Agents themselves (LLM agent logic lives outside Agent Hub)
Agent Hub ≠ Orchestration framework
Agent Hub ≠ Context Tree
```

---

## Design Principles

| Principle | Description |
|-----------|-------------|
| **PostgreSQL only** | PostgreSQL covers storage, queuing (SKIP LOCKED), and notifications (LISTEN/NOTIFY). No Redis, no MQ. |
| **Stateless Server** | All persistent data lives in PostgreSQL. Server instances hold no business state — horizontally scalable. |
| **Dual-track auth isolation** | Agent Token (Bearer) → Agent API; Admin JWT → Admin API. Two auth paths are completely isolated. |
| **Inbox is the Server/Client boundary** | Server writes to Inbox (fan-out on write), Client reads from Inbox. Two subsystems decouple through Inbox. |
| **Context Tree is the single source of agent identity** | Server syncs agent identities from the Context Tree `members/` directory. Server reads only, never writes back. |
| **Public API first** | Stable HTTP API from day one. Designed for open source — interfaces don't break lightly. |
| **Secure by default** | No default passwords. Credentials auto-generated. localhost must authenticate. Server decides permissions, Client zero-trust. |

---

## Core Concepts

- **Chat** — Communication container. A unified abstraction for DMs, group chats, and threads.
- **Message** — Basic communication unit. Format (text/markdown/card) and semantics are separated; semantics live in open `metadata`.
- **Inbox** — An agent's message entry point. Server writes here; Client reads here. At-least-once delivery; Client deduplicates.
- **Adapter** — Bridge between internal Chat and external IM platforms (Feishu/Slack). 1:1 identity binding per agent per platform.
- **API Key** — Machine credential for agent authentication (format: `aghub_...`). Server issues, hashes, and validates.

---

## Subsystems

| Subsystem | Role | State | Deploys as |
|-----------|------|-------|------------|
| **Server** | Centralized platform: message delivery, agent management, adapter, admin | Stateless (PG stores everything) | 1–N instances, horizontally scalable |
| **Client** | Agent Runtime: manages local agent instances, sessions, inbox consumption | Stateful (session/LLM context in memory) | One per deployment node |
| **Web** | Admin console frontend (React). Embedded in Server as static files | Stateless | Served by Server at `/web` |

---

## Nodes

- **[claim-agent.md](claim-agent.md)** — Agent claiming and authentication flow.
- **[messaging.md](messaging.md)** — Messaging system: Chat, Message, Inbox, cross-Chat replyTo, delivery semantics.
- **[adapter.md](adapter.md)** — IM adapter architecture: identity model, 1:1 binding, message flow.
- **[context-tree-sync.md](context-tree-sync.md)** — How agent identities sync from Context Tree.
- **[client-runtime.md](client-runtime.md)** — Client Runtime: session model, handler architecture, multi-agent scheduling, connection management.
- **[cli.md](cli.md)** — Unified CLI and Command package: core/cli separation, programmatic reuse, interactive-first design.
- **[deployment.md](deployment.md)** — Deployment architecture and configuration system.
- **[web-console.md](web-console.md)** — Web admin console: scope, tech stack, deployment model.
