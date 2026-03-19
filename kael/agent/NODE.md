---
title: Agent
owners: [yuezengwu, baixiaohang]
---

# Agent

How Kael thinks and acts internally — the AI brain. Tools, memory, scheduling, skills.

Native tools are low-level, reusable utilities the agent can invoke directly — not tied to any specific skill. Skill-specific tools live in [skills/](../skills/) alongside their skill.

- **[Tools](tools.md)** — 30+ tools across 10 domains (react, file, document, web, browser, sandbox, desktop, slides, subtasks, memory, cronjob, skills)
- **[Runtime](runtime.md)** — Long-running task execution, recovery, message queue
- **[Memory](memory.md)** — Three-layer memory system (Core + Archival + Episodic Buffer). How Kael remembers across sessions.
- **[Context Management](context.md)** — Two-layer progressive context management. How Kael prevents long conversations from overflowing.
- **[Skills](skills.md)** — Skill runtime mechanics: SKILL.md format, discover/activate/execute lifecycle, storage architecture, admin platform, and Skills UI protocol. For the conceptual definition of what a skill is and individual skill implementations, see [skills/](../skills/).

---

## Agent Registry

A unified configuration system maps agent types to capabilities. Each type defines a model, system prompt, and tool set tailored to its use case.

| Type | Tools | Use Case |
|------|-------|----------|
| **DEFAULT** | All tools (30+) | Full-featured assistant — handles any user request |
| **FAST** | react, document, web | Quick responses without heavy tool use |
| **RESEARCHER** | react_sub, document, web | Dispatched as subtask for research |
| **CODER** | react_sub, sandbox, document, file | Dispatched as subtask for code generation |
| **CLAUDE_CODE** | External executor | Code-to-code workflows via Claude Code CLI |

All agents use Anthropic Claude Sonnet 4.6 via OpenRouter. The registry is the single source of truth for what each agent type can do — adding a tool to a domain automatically makes it available to all agent types configured for that domain.
