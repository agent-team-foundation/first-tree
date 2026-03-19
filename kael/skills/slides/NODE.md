---
title: Slides
owners: [liuchao-001]
---

# Slides

A skill that generates AI-powered presentations from source documents. Users upload or reference documents; Kael produces a fully styled, image-rendered slide deck that can be browsed, edited, and exported to PDF.

Slides is an extended skill: it bundles a multi-agent workflow, native tools, and a dedicated frontend panel. See [skills/](../NODE.md) for the general definition of an extended skill.

**Preview and caching:** → [chat/preview/slides.md](../../chat/preview/slides.md)

---

## Architecture

The slides skill is implemented as **a set of tools available to the main chat agent**, not a separate multi-agent system. Each tool internally calls a specialized LLM with its own prompt and tools.

```
Main Chat Agent
├── generate_slides_content   → Slides Content Agent (has document tools)
├── generate_slides_styles    → Slides Style Agent
├── present_slides_styles     → Emits InteractiveRequest for user style selection
└── generate_slides_images    → Visual Design Agent → Gemini image generation
```

**Why tools, not agents:** Tasks are well-defined with no autonomous reasoning needed between steps. The main agent retains full conversation context across all steps. Lower latency, simpler debugging.

**Determinism as a design goal.** The slides workflow is intentionally structured with high determinism: each step has a fixed role, fixed inputs, and predefined expectations about slide composition and structure. This is deliberate — output stability and quality depend on the workflow being predictable. When a step is ambiguous or the agent has too much freedom in how it sequences the workflow, quality degrades. Resist the urge to collapse steps or give the agent more flexibility without a concrete reason.

---

## Workflow

### New Presentation

```
1. generate_slides_content
   Content Agent reads source docs, produces slide outline (markdown per slide),
   extracts references to existing figures/tables, specifies diagrams.
   → Creates SlidesContent record, asset status → PROCESSING
   → No outline preview in frontend (deliberate — reduces interaction complexity)

2. generate_slides_styles + present_slides_styles
   Style Agent generates 1–3 styles. Sample image rendered per style.
   If ≥ 3 styles: InteractiveRequest → user selects via style cards in UI.
   If 1–2 styles: text confirmation only.

3. generate_slides_images
   Visual Design Agent generates per-slide layout spec (slide_visual).
   Slide 0 rendered first; remaining slides rendered in parallel using slide 0
   + style sample as reference images (ensures visual consistency across deck).
   OCR extracts text_regions from each rendered image.
   → Asset status → ACTIVE only when ALL slides have images.
```

### Content Edit

The Content Agent uses **incremental operations** (insert/delete/replace) — it never returns a full deck replacement. **Minimal update principle:** the agent only generates operations for slides explicitly mentioned in the instruction. Unchanged slides keep their existing images untouched.

After content updates, only slides where `is_slide_image_up_to_date = False` are passed to image generation. The Visual Design Agent in modification mode copies `slide_visual` verbatim and applies only the minimum necessary changes — avoiding unnecessary visual drift.

### Visual Edit (via frontend)

Users click on a slide, adjust text regions or anchor points. The frontend builds a `SlideEditAttachment` with per-slide edit hints and sends it as a message attachment. The agent calls `generate_slides_images` with `edit_hints` per slide. **Both text edits and anchor-point edits require `edit_hints`** — anchor edits were originally excluded, leaving Gemini without context about what changed.

In edit mode, image generation uses a focused edit prompt. **Reference images are skipped in edit mode** — Gemini's multi-modal generation gives significant weight to visual references; when a reference image contains stale text, Gemini copies it instead of rendering from the updated prompt. The two use cases (style matching vs. text accuracy) are incompatible and require separate prompt paths.

**Re-render, don't patch:** The edit prompt explicitly instructs Gemini to re-render all affected text completely from Slide Content, not patch text in place. Patching produces visible seams.

### Asset Status Lifecycle

```
create / generate content / generate styles  → PROCESSING
generate images: in progress                 → PROCESSING
generate images: all slides have images      → ACTIVE
generate images: partial failure             → PROCESSING (agent may retry)
content edit, images already up to date      → ACTIVE immediately
content edit, images now stale               → PROCESSING until regenerated
```

ACTIVE is only set when every slide has a rendered image. Partial completion stays PROCESSING so the frontend shows a loading state rather than a partial deck.

---

## Style Sample Optimization

When generating the representative slide, the service checks whether the current slide matches the style's sample image:

- **Hash matches:** copy the existing sample image and `slide_visual` directly — no Gemini call.
- **Hash mismatches** (slide was edited since sample was generated): regenerate normally.

The content hash covers both `content` and `slide_visual`. A visual-only change (e.g. anchor edit) changes the hash and forces regeneration — preventing the sample copy from overwriting an edited slide.

**Guard:** The copy is also skipped if the representative slide already has a `slide_image_id`, meaning it was edited after style selection and its image is more recent than the sample.

---

## Known Pitfalls

**Passing a reference image in edit mode creates an unsolvable tension.** When a reference image of the previous slide is passed alongside updated content, two failure modes emerge depending on how strict the prompt is:
- *Prompt not strict enough*: Gemini treats the reference image as the primary source and ignores small textual changes — the output is nearly identical to the original.
- *Prompt too strict* (e.g. "render exactly according to the content outline"): Gemini modifies the targeted text but treats surrounding text as "preserved from reference", causing it to become blurry in the new image.

These two failure modes sit at opposite ends of the same dial and cannot both be avoided through prompt tuning. The current solution is to not pass reference images in edit mode — Gemini regenerates the slide entirely from content. This works because the slide structure (content outline, references, diagrams, and `slide_visual` layout spec) is specified precisely enough that the regenerated image is good-looking and structurally close to the original, which users find acceptable.

If Gemini's instruction-following improves significantly in the future, passing a reference image in edit mode could be reconsidered — it would help maintain tighter visual consistency between edits. The prerequisite is that the model can reliably apply targeted changes without either ignoring them or blurring surrounding content.

**Accidentally modified slides become permanently stale.** When the user asks to modify slides 2 and 4, the Content Agent occasionally also modifies a third slide outside the requested scope — even with the minimal update constraint in place. That slide's `is_slide_image_up_to_date` is set to `False`, but the agent then calls `generate_slides_images` with `slide_indices=[2, 4]` (only what the user asked for). The accidentally-modified slide is not in `slide_indices`, so it is never regenerated and stays stale permanently — its image no longer matches its content, with no recovery path.

Fix: `generate_slides_images` always auto-includes every slide where `is_slide_image_up_to_date = False`, regardless of `slide_indices`. Do not bypass this check.

**Content hash must include `slide_visual`.** Hashing only `content` means a visual-only change (e.g. decoration edit) does not invalidate the cached image — the old image is silently reused. The hash must cover both `content` and `slide_visual`.

**Visual Design and Style prompts must use distinct field names.** Both prompts originally used the field name "Visual Elements". When they appear together in the same context window, the Visual Design Agent conflated its own schema with the Style schema and dropped custom visual decorations. Visual Design output is now named "Slide Decorations".

**REFERENCE assets have a different ID scheme than document assets.** `slide_image_id` on a `SlideItem` is the `project_asset.id` (a UUID). The `file_id` returned by the files batch API is a SHA-256 content hash. Code that looks up slide images by `file_id` must handle this mismatch. Similarly, document lookup by `document_id` fails for slides because for REFERENCE assets, `document_id` refers to the slides session ID, not `project_asset.id`. Lookups must check both: `d.document_id === id || d.id === id`.

**Generic file tools fail silently on REFERENCE assets.** `file_read`, `file_present`, and `doc_read_*` assume all `file://` URIs point to document assets with a `content_hash`. REFERENCE assets have a different structure and no `content_hash` on the asset record — these tools return misleading errors rather than directing the agent to use slides-specific tools.
