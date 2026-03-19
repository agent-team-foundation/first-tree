---
title: Slides Preview
owners: [liuchao-001]
---

# Slides Preview

How the slides panel loads, caches, and displays slide images. This is the slides-specific implementation of the preview infrastructure described in [chat/preview/](NODE.md).

---

## Image URLs

Slide images are served as stable proxy URLs:

```
/api/files/{file_id}/content?v={content_hash}
```

The `content_hash` query parameter is the cache-busting key. When a slide is regenerated, a new `file_id` is created with a different hash, changing the URL. The browser caches the old URL indefinitely (via `Cache-Control` + `ETag` forwarded from the backend) and fetches the new URL on first access. No in-memory blob URL cache is maintained — the browser HTTP cache handles everything.

---

## When the Frontend Fetches Slides

Slide data is loaded lazily — only when a presentation is selected. A fetch is triggered by:

- User clicks a presentation in the documents panel
- A `generate_slides_images` tool result arrives → auto-opens the panel
- A project asset change event arrives for the active presentation

**Targeted invalidation:** When a tool result updates one presentation, only that presentation's cache entry is cleared. Other open presentations preserve their loaded state.

**`generate_slides_content` does not auto-open the panel.** It sets a `slidesAwaitingImagesRef` flag. Only `generate_slides_images` clears the flag and triggers auto-open. This prevents the panel from opening on content-only state (no images yet).

**FAILED status is still previewable.** The panel does not block on ACTIVE status — a presentation with FAILED asset status can still be opened to show whatever slides were generated successfully. Blocking on ACTIVE would prevent users from seeing partially-generated content when image generation fails for some slides.

---

## Progressive Loading

The panel is openable during PROCESSING — it does not wait for all images to be ready. Each slide independently resolves its own state:

```
isImageReady = is_slide_image_up_to_date && slide_image_id && imageUrl
```

Slides with `isImageReady = true` display their image immediately. Others show a numbered placeholder with the slide title.

---

## Partial Edit Reload

When a subset of slides is edited, `loadPresentationSlides` does an **incremental merge** rather than full array replacement. For each slide, if `id`, `url`, `content`, and `isImageReady` all match the existing cached entry, the existing object reference is preserved. React sees no change for unmodified slides → no re-render → no spinner on unchanged slides.

Loaded state is tracked by **URL** (`loadedUrls: Set<string>`), not by slide index. This means a slide that was already displayed keeps its loaded indicator even when the slides array is partially replaced. Index-keyed tracking fails because any partial reload that changes `slides[0].id` resets the entire loaded set.

---

## Concurrent Load Race Condition

`loadPresentationSlides` uses a `loadRequestCounterRef`. Each invocation increments the counter before starting, then checks it after every `await`. If a newer request has started by the time an older one resolves, the older result is discarded without writing to state.

This pattern must be applied to **every async function that writes panel state**. Missing even one `await` boundary means a slow-resolving older request can overwrite the results of a faster newer one. The fix is always the same: increment on entry, check after each await, return early if counter has advanced.

When a stale request is discarded, `isLoading` must still be reset to `false` for the target presentation in every early-return path — not just the happy path. A missing reset leaves the presentation permanently in a loading state.
