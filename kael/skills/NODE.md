---
title: Skills
owners: []
---

# Skills

Skills are Kael's functional capabilities — units of behavior that can be loaded into an agent session to extend what Kael can do.

---

## What a Skill Is

A skill is not just a prompt. In Kael, a skill is a **functional unit** that can bundle:

- **Instructions** — a system prompt that shapes how the agent behaves in this context
- **Native tools** — code-defined tools the agent can invoke as part of the skill's workflow
- **UI interactions** — frontend components and interaction flows tied to the skill's output

This is an extension of the conventional definition of "skill" (which treats skills as prompt-only). Kael skills can own the full stack from agent behavior to user-facing interface.

## What a Skill Is Not

A skill is not the agent's core reasoning infrastructure. The loop, context management, memory, and scheduling live in [agent/](../agent/). A skill is what the agent *does*, not how it *thinks*.

Native tools that are not tied to any specific skill — low-level, reusable utilities — live in [agent/](../agent/).

---

## Domains

- **[slides/](slides/)** — AI-powered presentation generation from source documents
