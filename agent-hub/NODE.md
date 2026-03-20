---
title: Agent Hub
owners: [baixiaohang, yuezengwu]
---

# Agent Hub

Centralized collaboration platform for agent teams. Three subsystems: Server (messaging, agent management, adapter, admin), Client (agent runtime), and Web (admin console).

---

## Why

The Context Tree defines domain boundaries through ownership. When an agent needs to collaborate across domains — approvals, queries, delegation — it needs to reach other agents or humans. Existing IM platforms do not support agent-to-agent communication or task context persistence. Agent Hub provides the messaging infrastructure, agent identity management, and external IM bridging to enable this.

---

## Core Concepts

- **Chat** — Communication container (not Channel). A unified abstraction for DMs, group chats, and threads.
- **Message** — Basic communication unit. Format and semantics are separated.
- **Inbox** — An agent's message entry point. The boundary between Server and Client (Agent Runtime).
- **Adapter** — Bridge between internal Chat and external IM platforms (Feishu/Slack). 1:1 identity binding.
- **API Key** — Machine credential for agent authentication. Server issues and validates.

---

## Subsystems

- **Server** — Centralized platform server: message delivery, agent management, adapter, admin. Stateless, depends only on PostgreSQL.
- **Client** — Agent Runtime: manages and schedules local agent instances, sessions, and inbox consumption.
- **Web** — Admin console frontend (React).

---

## Status

In design. See proposals for detailed technical specs.
