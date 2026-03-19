---
title: Memory System
owners: [baixiaohang]
soft_links: [/kael/knowledge]
---

# Memory System

Kael's memory system gives the agent persistent, per-user knowledge that survives context window compression and session boundaries. When a long conversation triggers compaction, the agent doesn't lose what it learned — memory captures it before compression discards it.

---

## Architecture: Modified MemGPT Three-Layer

```
L1 Core Memory    (~2K tokens, always in system prompt)
       ↑ compiled from
L2 Archival Memory (atomic knowledge entries, vector + full-text indexed)
       ↑ consolidated from
Episodic Buffer    (per-turn summaries, temporary)
```

**Why this architecture.** We evaluated four alternatives:

| Approach | Why not |
|----------|---------|
| **Mastra Observational Memory** | SOTA on LongMemEval (94.87%), but no external persistent storage — information degrades irreversibly through repeated compression. Kael needs topic-switch recall across sessions, which requires a complete external store. |
| **MemOS** | Over-engineered for our use case — includes KV-cache management and LoRA distillation we don't need. |
| **Mem0** | No "always visible" layer. Agent must actively search to see anything. We need the agent to always know core user context without a tool call. |
| **MemGPT (original)** | Right structure, but relies on agent self-management for writes (30-40% miss rate) and Core Memory maintenance (agents hoard entries until overflow). We automated both. |

The modified MemGPT three-layer keeps the strengths (always-visible Core, complete external Archival, clear information density gradient) while replacing agent self-management with system automation.

---

## Write Path: Fast + Slow Dual Pipeline

The original design extracted memories during context compaction. This had three problems:
1. Short sessions (<144K tokens) never triggered compaction, so no memories were created
2. Processing 100K+ tokens at once caused significant information loss
3. Context management and memory extraction were coupled

**Current design decouples them:**

- **Fast path (per-turn):** After each agent turn, a background Gemini Flash call summarizes the turn into 2-4 sentences and writes to the Episodic Buffer. Cost: <$0.001/turn. Fire-and-forget, 100% coverage.
- **Slow path (consolidation):** When buffer entries accumulate (threshold: 2 entries) or user goes idle (15 min), a consolidation pipeline extracts atomic knowledge entries from buffer summaries into L2 Archival Memory. Entries are categorized as FACT / PREFERENCE / DECISION / TASK_STATE / INSIGHT with priority levels.

This was inspired by MAGMA's dual-stream write (fast events + slow structural consolidation), adapted for our simpler needs.

**Deduplication and supersede detection** uses a three-stage pipeline: content hash exact match → vector similarity coarse filter (threshold 0.7-0.85) → LLM judge for final supersede decision.

---

## Read Path: Three-Level Guarantee

1. **Core Memory (always visible)** — A compiled ~2K token Markdown summary injected into the system prompt via `<core-memory>` tags. Auto-compiled from highest-priority L2 entries. Cached in memory (TTL 300s). The tag has no dynamic attributes (no timestamps, no pending counts) to maximize prompt cache hit rate.

2. **Agent search (on demand)** — `memory_search` tool: hybrid vector + full-text search with RRF fusion, optional Cohere reranking. Scoring: `score = similarity × recency_decay × priority_weight` (half-life 14 days).

3. **Detail recall (deep dive)** — `memory_read_detail` tool: a sub-agent loads the original conversation from the source session and extracts specific details. This is the fallback when L2 entries lack sufficient granularity.

**Why no auto-injection:** AMA-Bench (2026.2) showed similarity-based retrieval is unreliable for agent execution traces (dense causal transitions). Per-turn embedding + vector search also has non-trivial cost. Core Memory already covers long-term essentials; agent-initiated search is more precise than automated "recent message" queries.

---

## Storage

Reuses Kael's existing dual-database infrastructure:
- **Business DB (PostgreSQL):** `memory_entries` (L2), `core_memories` (L1), `memory_episodic_buffer` (buffer). Lifecycle states: ACTIVE → SUPERSEDED → ARCHIVED.
- **Vector DB (PostgreSQL + pgvector):** `memory_embedding_1536` with Vertex AI `gemini-embedding-001` embeddings. Full-text search via `tsvector` for keyword matching.

No new infrastructure (Neo4j, OpenSearch, etc.) was introduced.

---

## Key Design Decisions

**Writes are fully automated.** The `memory_save` tool was removed. Fast path provides 100% baseline coverage; slow path does precise extraction. This eliminates "metacognitive overhead" — the agent spends tokens on the task, not on deciding what to remember.

**Core Memory is auto-compiled, not agent-managed.** MemGPT lets agents edit Core Memory directly, but agents hoard entries and forget to update. Our compiler selects from L2 by priority, so L2 is always the complete record and Core is a lossy high-frequency summary.

**Consolidation is per-user, not per-session.** Memory is per-user. Session lifecycle is unreliable (long-running sessions have no clear end). Triggers: entry count threshold + user-level debounce timer (15 min idle).

**Buffer is write-only for context.** The buffer is a degraded version of raw messages — injecting it would duplicate information already in the conversation or compaction summary. Its value is as consolidation input, not as context.

**Sensitive data protection is prompt-level.** The extraction prompt explicitly forbids extracting API keys, passwords, tokens, and credentials. No structural enforcement yet (Phase 2 consideration).

---

## Current State & Future Direction

**Implemented (Phase 1):** Episodic buffer, L2 extraction pipeline, Core Memory compilation, search (hybrid + reranking), system prompt injection, startup recovery sweep.

**Planned:**
- Phase 2: Graph-based memory (entity relationships), cross-session memory linking
- Phase 3: Proactive memory surfacing, memory-informed task planning

---

## Source Documents

Design details and implementation plans: `kael-backend/doc/memory/memory-system-design.md`
Technology landscape research: `kael-backend/doc/memory/agent-memory-technology-landscape.md`
