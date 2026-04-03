---
title: Context Tree
owners: [liuchao-001, 286ljb, baixiaohang]
---

# Context Tree

The living source of truth for your organization. A structured knowledge base that agents and humans build and maintain together.

---

## Principles

1. **Source of truth for decisions, not execution.** The tree captures the *what* and *why* — strategic choices, cross-domain relationships, constraints. Execution details stay in source systems. A node earns its place by compressing knowledge that would require traversing multiple systems to derive.

2. **Agents are first-class participants.** The tree is designed to be navigated and updated by agents, not just humans. Domains are organized by concern — what an agent needs to know to act — not by repo, team, or org chart.

3. **Transparency by default.** All information is readable by everyone. Writing requires owner approval; reading is open.

4. **Git-native tree structure.** Each node is a file; each domain is a directory. Soft links allow cross-references without the complexity of a full graph. History, ownership, and review follow Git conventions.

See [principles.md](principles.md) for detailed explanations and examples.

---

## Domains

- **[kael/](kael/NODE.md)** — AI agent product: reasoning, skills, knowledge, chat, environment, platform.
- **[context-tree/](context-tree/NODE.md)** — Context Tree CLI, framework, templates, and onboarding.
- **[marketing/](marketing/NODE.md)** — Brand, positioning, campaigns, content strategy.
- **[members/](members/NODE.md)** — Member definitions and work specifications.
- **[agent-hub/](agent-hub/NODE.md)** — Agent collaboration platform: messaging, agent management, adapter, admin.
- **[open-source/](open-source/NODE.md)** — Open-source products, repo structure, and distribution.
- **[proposals/](proposals/NODE.md)** — Temporary files and process documents (not agent context).

---

## Working with the Tree

See [AGENT.md](AGENT.md) for agent instructions — the before/during/after workflow, ownership model, and tree maintenance.

See [about.md](about.md) for background — the problem, the idea, and who it's for.

See [ownership-and-naming.md](ownership-and-naming.md) for the node naming and ownership model.

See [infrastructure.md](infrastructure.md) for the six pillars of an agent-centric organization.
