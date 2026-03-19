---
title: Document Reading
owners: [baixiaohang]
---

# Document Reading

How the agent accesses document content. Three tools form a deliberate workflow: understand structure first, then read or search as needed.

---

## Usage Strategy

The system prompt instructs the agent: **call `doc_read_overview` first for any new document.** This is the entry point — the agent sees the document's title, abstract, and section tree before deciding how to proceed.

From there, two paths:

- **Target known** → `doc_read_section` by outline_id. The overview gives the agent a map; it picks the section it needs. Supports parallel calls (up to 10 concurrent) for reading multiple sections at once.
- **Target unknown** → `doc_search` to find relevant content by semantic query. Search results include outline_ids, so the agent can follow up with `doc_read_section` for full context around a matched chunk.

This overview-first design is intentional: it prevents the agent from blindly searching when a glance at the table of contents would suffice, and it provides the outline_ids needed for precise section access. `doc_read_all_content` exists as a fallback for small documents or when the agent genuinely needs everything.

The tools also compose with sub-agents: a `researcher` sub-agent is equipped with `doc_*` and `web_*` tools, making it the standard delegate for information gathering tasks.

---

## Structural Navigation

The agent reads documents through an outline-based system, not raw file access:

1. **`doc_read_overview`** — Returns document structure: title, abstract, section tree (with outline_ids), figure/table lists. Works as soon as parsing completes (EXTRACTED status), before embedding finishes.

2. **`doc_read_section`** — Reads a specific section by outline_id. Returns Markdown with image references mapped to file_ids. Supports 1-10 concurrent calls for parallel section reading.

3. **`doc_read_all_content`** — Returns the complete document as Markdown. Used when the agent needs the full picture.

**Why outline_ids instead of section titles:** The original design used string-based section title matching. LLMs frequently misspell or paraphrase titles, causing lookup failures. Sequential integer outline_ids eliminated this entirely — the agent picks from a structured menu, not free-text.

**File URI scheme:** `file://asset-id`. The agent never works with raw S3 paths — URIs are resolved through ProjectAsset → DocumentMaterial via content_hash.

---

## Semantic Search

When the agent needs to find relevant information across documents without knowing the exact location:

**`doc_search`** — Hybrid search across one or more documents. Returns ranked chunks with relevance scores, outline_ids (for follow-up section reading), and asset identifiers.

### Hybrid Search Pipeline

```
Query
  → Embed (Vertex AI, task type RETRIEVAL_QUERY)
  → Vector search (pgvector, cosine distance) — captures semantic similarity
  → Full-text search (PostgreSQL tsvector, ts_rank_cd) — captures keyword matches
  → RRF fusion (k=60) — merges both rankings without relying on absolute scores
  → Cohere rerank (optional, rerank-v3.5) — precision re-ordering
  → Top-k results
```

**Why RRF (Reciprocal Rank Fusion):** Vector and full-text scores are on different scales and not directly comparable. RRF merges rankings position-by-position, making it agnostic to score magnitude. The k=60 smoothing parameter balances influence between early-rank and tail results.

**Why hybrid over pure vector:** Pure vector search misses keyword-heavy queries (exact names, IDs, technical terms). Pure BM25 misses semantic matches (paraphrases, conceptual similarity). Hybrid catches both — this was validated through retrieval quality testing.

**Reranking:** Cohere `rerank-v3.5` as an optional precision layer. Runs with a 5-second timeout; on failure, falls back to RRF scores silently. The system never fails a search because reranking is unavailable.

### Embedding

Model: Vertex AI `gemini-embedding-001`, 1536 dimensions. Chosen for quality-cost balance within the Google Cloud ecosystem (Kael already uses Vertex for other services).

Query embeddings use task type `RETRIEVAL_QUERY` (different from `RETRIEVAL_DOCUMENT` used during processing) for asymmetric retrieval optimization.

---

## Access Control

All document tools validate project access — the agent can only read documents that belong to the current project. This is enforced at the tool layer: file URIs are resolved to ProjectAssets, and project membership is checked before any content is returned.

---

## Source Documents

Retrieval architecture history: `kael-backend/doc/archived/retrieval-system.md`
