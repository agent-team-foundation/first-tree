---
title: Context Management
owners: [baixiaohang]
soft_links: [/kael/agent/memory.md]
---

# Context Management

Two-layer progressive context management that prevents long conversations from overflowing the context window. Designed around a core insight: **tool output accounts for 80%+ of context consumption** — managing it is the highest-ROI intervention.

---

## Model Effective Context Windows

| Model | Effective Window | Role |
|-------|-----------------|------|
| Claude Sonnet 4.6 | ~200K tokens | Default agent |
| Gemini 3 Flash | ~600K tokens | Sub-agents (researcher, coder) |

System overhead (system prompt + tool definitions): ~10K tokens. Output reservation: 4K tokens. Available budget = window - overhead - reservation.

---

## Architecture

```
Layer 0: Input Control       — tool output hard limits (future)
Layer 1: Observation Masking — ≥60% utilization, mask old tool results
Layer 2: Compaction          — ≥80% utilization, compress all to structured summary
```

Each layer does minimal work. The system prefers preserving information over aggressive compression — a re-fetch after lossy compression costs more total tokens than keeping the original.

---

## Layer 1: Observation Masking

**Trigger:** Context utilization ≥ 60%.

Replaces old tool results with one-line markers like `[masked: sandbox_run, 8000 chars]`. The agent can re-call the tool at low cost if needed.

**Rules:**
- Last 3 request-response pairs are protected (never masked)
- Only results > 200 chars are candidates
- Error outputs (starting with `Error:`, `Traceback`, etc.) are preserved
- Web content tools (`web_fetch`, `web_search`, `browser_read`, `browser_computer`) get their output backed up to a sandbox file before masking, since external sources may change: `[masked: web_fetch, 5000 chars, file: /home/user/.context/web_fetch_msg12_a1b2c3d4.txt]`

**Persistence:** Original `content` column untouched. Masked version written to `llm_content` column. Subsequent loads use `COALESCE(llm_content, content)`.

---

## Layer 2: Compaction

**Trigger:** Context utilization ≥ 80%.

All messages are compressed into a single compaction message with six parts, ordered by attention optimization (start and end get strongest attention, middle is weakest):

1. **User Messages** (programmatic) — Raw user messages preserved without LLM rewriting. XML system tags stripped. 500 char limit per message, 50 messages max, accumulates across compaction cycles.
2. **Tool Artifacts** (programmatic) — Tool name + key parameters only, large content fields skipped. Current cycle only (LLM summary covers history).
3. **Recent Context** (raw) — Last 1 request-response pair, placed in the middle (weak attention zone) to reduce recency bias.
4. **File Context** (programmatic) — Current file list.
5. **Session Summary** (LLM) — Gemini Flash generates a structured summary with sections: Session Intent, Key Context, Progress, Errors & Corrections, Current State, Pending Work. Incremental: previous summary fed as input. Failure doesn't block — retries next cycle.
6. **Active TODO** (programmatic) — Current task plan with status markers. Placed last (strongest attention) to directly guide next action.

**Loading optimization:** Messages load from the latest compaction point, not from the beginning of the session.

---

## Design Principles

**Optimize tokens-per-task, not tokens-per-request.** Aggressive compression that forces the agent to re-fetch information increases total cost. Conservative compression with more preserved context is cheaper overall.

**Programmatic extraction over LLM summarization.** User intent is never LLM-rewritten — it's preserved verbatim. Tool artifacts are extracted programmatically. The LLM summary has a narrow scope: reasoning flow and key decisions only.

**Progressive degradation over sudden compression.** Two layers, each doing minimal work. Layer 1 (masking) is nearly lossless — the agent can re-call any tool. Layer 2 (compaction) is lossy but structured, with the most important information programmatically preserved.

**KV-cache friendly.** Masking creates new objects instead of mutating existing ones. Compaction appends rather than modifying. Content already in the cache is not disturbed.

---

## Source Documents

Design details and implementation plan: `kael-backend/doc/context-management-design.md`
