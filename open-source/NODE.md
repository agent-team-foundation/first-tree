---
title: Open Source
owners: [286ljb]
soft_links: [/context-tree, /agent-hub]
---

# Open Source

The Agent Team methodology — including the Context Tree, the Message System,
and the infrastructure for agent-centric organizations — is developed in the open.

**Domain:** agent-team.foundation
**GitHub:** github.com/agent-team-foundation

## Why Open Source

An agent team depends on shared infrastructure and shared norms.
Proprietary standards don't work here. The value comes from adoption —
the more teams that run this way, the stronger the ecosystem.

## What Is Published

- The definition of an Agent Team and its operating principles
- The six-pillar infrastructure specification (Autonomous Agent, Context Tree, Message System, Identity, Database, Workflow/Automation)
- The Context Tree specification and CLI
- The Message System protocol
- This repository itself — as a live example of an agent team in practice

## Repo Structure

Hub-and-spoke model — repos are organized by user journey, not by "docs vs code."

| Repo | Contains | User action | npm |
|---|---|---|---|
| `first-tree` | Concept docs, context-tree templates, context-tree CLI (TypeScript) | Fork → start using context tree | [first-tree](https://www.npmjs.com/package/first-tree) |
| `first-tree-hub` | Server, client SDK, web dashboard, CLI command | Deploy as a service | [@unispark.ai/agent-hub](https://www.npmjs.com/package/@unispark.ai/agent-hub) |

### Why this split

- **CLI belongs with templates.** The CLI's job is `init`, `verify`, `upgrade` — all template-centric operations. Keeping it in the same repo as the templates enables atomic updates.
- **`npx context-tree init` works immediately** after forking first-tree. Zero extra install step.
- **Agent-hub is a separate deployment concern** (Postgres, Docker, independent release cycle). Mixing it into first-tree would break the "fork and go" experience.
- **Future services** (storage layer, etc.) each get their own repo, linked from first-tree docs.

See [context-tree/](../context-tree/NODE.md) for CLI, framework, and template details.
