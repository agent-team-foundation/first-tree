---
title: Document Processing
owners: [baixiaohang]
---

# Document Processing

How raw files become searchable, structured data. The pipeline transforms uploads into a document representation the agent can navigate and search.

---

## Pipeline Overview

```
Upload (S3)
  → Download
  → Extract (raw file → Markdown)
  → Parse (Markdown → DocumentBlocks)
  → Outline (section tree + metadata)
  → Chunk (blocks → retrieval-sized pieces)
  → Embed (Vertex AI → pgvector)
```

Each stage writes a checkpoint. If processing fails or the server restarts, recovery resumes from the last checkpoint — no re-processing of completed stages. On startup, a sweep scans documents stuck in processing (within 24h) and re-queues them.

---

## Progressive Availability

A key design decision: **document tools become available before processing completes.**

```
PENDING → EXTRACTED → COMPLETED
```

- **EXTRACTED:** Parsing done. `doc_read_overview` and `doc_read_section` work. The agent can navigate the document structure immediately.
- **COMPLETED:** Embedding done. `doc_search` also works.

This was motivated by MinerU taking 70-85% of total processing time. Decoupling parsing from embedding eliminates the wait — users get structural access within seconds, not minutes.

---

## PDF Extraction: Dual Strategy

| Path | Tool | Speed | When |
|------|------|-------|------|
| Non-scanned | PyMuPDF4LLM | ~0.5s/page | Default — 4x faster than MinerU, quality sufficient for LLM consumption |
| Scanned (OCR) | MinerU (cloud API) | ~2s/page | Detected by character count (<100 chars/page via PyMuPDF sampling) |

**Why PyMuPDF4LLM over MinerU for non-scanned:** 4x speed improvement with acceptable quality trade-off. Formulas render correctly, images are extractable, tables have minor artifacts but LLMs can recover. MinerU remains the only option for scanned PDFs due to OCR requirements.

**Why not pass raw PDF to LLM:** 12x higher token cost compared to extracted Markdown. Not viable at scale.

HTML documents (from web fetch) are converted to Markdown via Tavily API before entering the same pipeline.

---

## Processing Stages

**Parsing:** Converts Markdown into typed DocumentBlocks (TEXT, HEADING, TABLE, FIGURE). Originally 8 block types; reduced to 4 — only types useful to the agent survived.

**Outlining:** Builds a DocumentOverview — title, abstract, section tree with sequential `outline_id` integers, figure/table lists, token counts per block. The outline_id system replaced string-based section title matching, eliminating LLM spelling errors when navigating documents.

**Chunking:** Splits blocks into retrieval-sized pieces (~1000 tokens target, 200 min). Rules: headings always merge with the next non-heading block (context preservation), tables and figures never split (semantic integrity), text blocks split at sentence boundaries when oversized.

**Embedding:** Vertex AI `gemini-embedding-001`, 1536 dimensions. Task type `RETRIEVAL_DOCUMENT` for chunks. Batch API: max 250 texts or 20K tokens per request, up to 10 concurrent batches. Stored in pgvector with tsvector for full-text search support.

---

## Concurrency Control

Processing is async via a task queue with fairness guarantees:

- **Per-user limit:** Max 10 concurrent tasks per user. Prevents one user's bulk upload from starving others.
- **PDF scheduling:** Three-layer semaphore — user (2 slots) → large file (2 slots, only for ≥50 pages) → global (3 slots, matches MinerU capacity). Small files skip the large-file semaphore for higher utilization.
- **Retry:** Linear backoff (10s → 60s → 120s), errors classified as retryable vs non-retryable.

---

## Image Handling

Images extracted during parsing are filtered (only those referenced in Markdown), uploaded to S3 with MD5-based file_ids (automatic dedup), and mapped via `image_file_ids` in DocumentMaterial. Agent tools replace image paths with file_id references for RAG safety — the agent never sees raw S3 URLs.

---

## Data Model

- **DocumentMaterial:** Core document store — raw_markdown, blocks, overview, image_file_ids, processing_stage, doc_metadata (page_count, is_scanned)
- **FileChunk:** Retrieval-sized text pieces — chunk_index, text, markdown, tokens, metadata (outline_id, source_page)
- **ChunkEmbedding:** Vector store — 1536-dim embedding, chunk_hash (change detection), search_vector (tsvector for full-text)

Content deduplication: `asset_id` is derived from content hash. Multiple projects can reference the same document without re-processing.

---

## Source Documents

PDF parsing optimization: `kael-backend/doc/fast-pdf-parsing-design.md`
Pipeline architecture history: `kael-backend/doc/archived/file-processing.md`
