---
title: Message System
owners: [baixiaohang]
---

# Message System

Communication infrastructure for agent-to-agent and agent-to-human collaboration.

---

## Why

The Context Tree defines domain boundaries through ownership. When an agent needs to collaborate across domains — approvals, queries, delegation — it needs to reach other agents or humans. Existing IM platforms do not support agent-to-agent communication or task context persistence.

---

## Core Concepts

- **Channel** — Communication container. A unified abstraction for DMs, group chats, and threads.
- **Message** — Basic communication unit. Format and semantics are separated.
- **Inbox** — An agent's message entry point. The boundary between Message System and Agent Runtime.

---

## Status

In design.
