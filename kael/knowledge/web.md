---
title: Web Information
owners: [baixiaohang]
---

# Web Information

How the agent acquires information from the internet. Unlike user-uploaded documents (which are trusted and always persisted), web content is agent-initiated, untrusted by default, and may be transient or persistent.

---

## Acquisition

The agent fetches web content via the `web_fetch` tool, which uses the Tavily API to download and convert pages to Markdown. Tavily was chosen for its extraction quality (handles JavaScript-rendered pages, strips navigation/ads) and speed.

**URL handling:** URLs are normalized to slugs (lowercase, non-alphanumeric → hyphens, truncated to 80 chars). Same URL always produces the same slug, enabling idempotent upsert — fetching the same page twice updates rather than duplicates.

---

## Quality Evaluation

**Core problem:** Web pages can contain login walls, ad-heavy content, cookie notices, or garbled text. Letting low-quality content into the agent's context wastes tokens and degrades reasoning.

**Solution:** A lightweight LLM evaluation (Gemini Flash) runs in parallel with content persistence. It scores content 1-10 and produces a brief summary.

| Score | Meaning |
|-------|---------|
| 1-3 | Low quality — blank pages, login walls, garbled text, pure ads |
| 4-5 | Marginal — incomplete, low information density, noisy |
| 6-7 | Usable — has value but with defects (truncation, mixed ads) |
| 8-10 | High quality — complete, dense, well-structured |

**What the agent receives:** A text summary with the quality score and a condensed version, plus the file path to full content. The agent decides whether to read deeper based on the score. Full content is not injected into context by default — only the summary is.

**Why evaluate only the first 10K characters:** Quality can be judged from the beginning of a page. Sending 50K characters to the evaluation LLM wastes tokens without improving judgment accuracy.

**Failure tolerance:** If evaluation fails, the content is still saved and returned with an explanatory note. Evaluation is enhancement, not a gate.

---

## Persistence

Web content is saved as a single Markdown file with YAML frontmatter containing metadata (URL, title, quality score, summary, fetch timestamp). Stored as an EXTERNAL asset type in the project.

```markdown
---
url: https://example.com/article
title: "Article Title"
quality_score: 8
summary: "Comprehensive overview of..."
fetched_at: 2026-01-15T10:30:00Z
---

# Article Title
Content here...
```

**Why single file with YAML frontmatter (v4):** Earlier designs used separate content and metadata files (v3), or a dedicated database table (v2). Single-file YAML reduces S3 requests, keeps metadata co-located with content, and is natively readable by both humans and LLMs.

**Storage evolution:** v1 (simple workspace file) → v2 (DB table) → v3 (content.md + metadata.json) → v4 (single file, YAML frontmatter). Each iteration simplified the architecture.

---

## Frontend Presentation

Web documents display in a dedicated panel with iframe loading of the original URL. When the original site blocks iframe embedding (via X-Frame-Options — common on GitHub, Google, etc.), the system detects this and falls back to rendering the saved Markdown content with a "View original" link. This degradation is treated as a normal case, not an error.

---

## Source Documents

Web fetch architecture: `kael-backend/doc/web-fetch-refactoring-design.md`
Quality evaluation design: `kael-backend/doc/webpage-quality-evaluation.md`
