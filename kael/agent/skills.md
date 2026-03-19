---
title: Skills System
owners: [baixiaohang]
soft_links: [/kael/chat, /kael/environment/sandbox.md]
---

# Skills System

Skills extend Kael's capabilities beyond its built-in tools. A skill is a self-contained package — a SKILL.md instruction file plus optional scripts and assets — that the agent loads on demand. Skills enable new workflows (slide generation, data analysis, etc.) without modifying core agent code.

---

## Lifecycle: Discover → Activate → Execute

**Discovery.** On each agent run, enabled skills are injected into the system prompt as `<available_skills>` metadata (name + one-line description). The agent sees what's available without loading any content. This is system-driven injection, not agent-initiated discovery — reduces interaction steps and follows progressive disclosure.

**Activation.** When the agent decides to use a skill, it calls `skill_activate(skill="builtin/slides")`. This loads the full SKILL.md content into context and downloads skill files to the sandbox at `/mnt/skills/{category}/{name}/`. A dedicated activation tool (rather than a generic file read) provides clear semantics and auditability.

**Execution.** The agent follows the SKILL.md instructions using standard tools — primarily `sandbox_run_command` to run scripts in the skill directory. No skill-specific execution tools are created; reusing existing sandbox tools reduces agent cognitive load.

**Native tool injection.** Some skills declare `native_tools` in their frontmatter (e.g., slides declares a `slides` toolset). When activated, these tools are dynamically injected into the running agent session via `session_skill_activations` tracking. This happens at the start of each agent iteration — no restart needed.

---

## SKILL.md Format

Based on the Anthropic Skills Protocol (SKILL.md as a lightweight, portable Markdown format), extended with Kael-specific fields:

```yaml
---
name: slides                           # kebab-case, 1-64 chars
description: Generate presentations     # used for discovery matching
native_tools: slides                    # optional: toolset or {toolsets, tools}
---

# Markdown instructions for the agent...
```

The body is free-form Markdown that the agent reads as operating instructions. Skills are identified by `category/name` (e.g., `builtin/slides`, `user/my-tool`) at the agent layer, mapped to UUID primary keys in the database.

---

## Storage Architecture

```
S3 (source of truth)          DB (metadata + S3 location)         Local (cache)
skills/{env_prefix}/          skills table: id, category,         skills/builtin/
├── builtin/slides/           name, s3_bucket, s3_prefix          ├── slides/SKILL.md
│   ├── SKILL.md                                                  └── kael-api/SKILL.md
│   ├── scripts/
│   └── references/
└── user/{user_id}/           user_skill_settings table:
    └── my-skill/             user_id, skill_id, is_enabled
```

**Environment isolation** via S3 path prefix: `dev/alice`, `staging`, `prod`. Staging and prod backends run identical code — only `SKILLS_S3_PREFIX` differs.

---

## Admin Platform

A separate Next.js app (kael-skills-admin on Vercel) manages builtin skills through a Staging → Prod publish flow:

1. Upload ZIP to staging (presigned URL direct to S3, bypasses Vercel 5MB limit)
2. Confirm upload → register in DB, parse SKILL.md
3. Test on staging environment
4. "Publish to Prod" → backend copies `staging/` → `prod/` in S3

Both environments expose identical APIs; the admin frontend switches between them via tabs. Security: API Key (`X-Internal-API-Key`) + Basic Auth.

**Why a platform over code-repo management:** The original design managed builtin skills in the code repo with startup-time boto3 sync. The platform approach removes deployment coupling — skills can be updated without backend redeployment, and the staging/prod flow provides safer rollout.

---

## Skills UI: Agent ↔ User Interaction

Skills can render interactive UI via iframe, enabling workflows that go beyond text (quizzes, dashboards, document viewers).

### Protocol Selection

We evaluated four external protocols and chose to self-build:

| Protocol | Verdict | Why |
|----------|---------|-----|
| **MCP Apps** | Recommended for future exploration | Best ecosystem maturity (Anthropic, OpenAI, Microsoft, Block). HTML rendering in sandboxed iframe. But Python SDK support uncertain, and our pydantic-ai integration needs differ. |
| **AG-UI** (CopilotKit) | Monitor only | No stable release yet. Protocol still evolving. |
| **Google A2UI** | Not adopted | Still v0.8 preview. Requires frontend renderer implementation. Declarative JSON limits flexibility. |
| **Skills Protocol** (Anthropic) | Adopted for SKILL.md format | Great for knowledge injection and workflow definition. No UI capability — supplements, doesn't replace our UI approach. |

**Why self-build over MCP Apps:** Our Skills UI needs features MCP Apps doesn't provide — streaming data updates from agent to iframe, pydantic-ai structured data validation, and UI events routed through the Chat API to preserve full conversation context. The bridge.js postMessage format is kept close to JSON-RPC for potential future MCP Apps compatibility.

### Two-Phase Evolution

**Phase 1 (implemented): Full HTML generation.** The agent generates complete HTML via skill scripts, uploads to S3, frontend renders in iframe. User interactions go through `bridge.js agent.send()` → postMessage → Chat API `ui_event`. Updates destroy and recreate the iframe.

**Phase 2 (designed): Data-driven templates.** Skills provide persistent HTML templates with a `render(data)` function. The agent pushes JSON data via `render_skill_html` tool; the same iframe updates reactively without rebuilding. Templates are autonomous — they handle internal interaction logic (e.g., quiz scoring), while the agent only pushes content data.

Key design decision: **all UI capability calls route through the agent** (not directly to backend APIs). This keeps things simple, secure, consistent, and auditable — the agent is always in the loop.

### Bridge Architecture

```
iframe (skill template)
  ↕ bridge.js (postMessage)
Bridge Layer (host frontend)
  ↕ HTTP POST / SSE
Chat API (backend)
  ↕
Agent (pydantic-ai)
```

bridge.js API: `agent.send(event, payload)` (send to agent), `agent.onData(callback)` (receive from agent), `agent.files.read(fileId)` (read project files, host-proxied, no credentials exposed to iframe).

---

## Current State

**Implemented:** Builtin skills lifecycle (discover/activate/execute), native tool dynamic injection, admin platform (staging/prod), Phase 1 UI (full HTML generation + bridge.js send).

**Planned:** User-uploaded skills (Stage 2), Phase 2 data-driven UI, MCP Apps compatibility exploration.

---

## Source Documents

Runtime architecture: `kael-backend/doc/skills-runtime-overview.md`
Admin platform design: `kael-backend/doc/skills-admin-platform-design.md`
UI protocol design: `kael-backend/doc/skills-ui-design/skills-ui-design-doc.md`
Data-driven design: `kael-backend/doc/skills-ui-design/skills-ui-data-driven-design.md`
Protocol research: `kael-backend/doc/skills-ui-design/` (ag-ui, google-a2ui, mcp-apps, skills-protocol, agent-ui-patterns)
