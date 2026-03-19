---
title: Kael
owners: [liuchao-001, 286ljb]
---

# Kael

Kael is an AI agent product. It is a persistent participant in an agent-centric organization — it processes tasks continuously and coordinates with humans and other agents through a message system.

Kael is a multi-repo product: a FastAPI backend, a Next.js frontend, a Chrome browser extension, and a Tauri desktop app.

---

## Domains

- **[agent/](agent/)** — the AI brain: reasoning loop, context management, memory, scheduling, native tools.
- **[skills/](skills/)** — Kael's functional capabilities: skills that bundle instructions, tools, and UI into complete feature units.
- **[knowledge/](knowledge/)** — documents in and out: ingestion, parsing, retrieval, search, embeddings. How Kael acquires and surfaces information.
- **[chat/](chat/)** — user-agent conversation: sessions, streaming, message history, interactive flows, file preview.
- **[environment/](environment/)** — acting on the world: browser control, desktop execution, sandbox. How Kael operates in external systems.
- **[platform/](platform/)** — auth, identity, projects, workspace, integrations, billing, safety. Cross-cutting infrastructure that supports everything.

---

## Practices

- **Design docs split between tree and code.** The tree captures the decision, rationale, and cross-repo implications. Code repo `doc/` keeps the implementation plan (specific files, migration steps, API changes). They link to each other.
- **Consider security and privacy in every design.** Features that touch user data, credentials, or cross-service communication must account for security during design — not after implementation. Read [platform/security/](platform/security/) for known issues and constraints. Apply the principle of least privilege: a component should only have access to what it needs to function.
