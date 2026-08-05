# First-chat Orientation videos

Deterministic product demonstrations rendered from the real First Tree Web design system. The recording route uses fixed local fixtures: it does not sign in, call the API, or modify onboarding state.

## Shot list

| Chapter | Duration | Shots |
| --- | ---: | --- |
| `multi-agent` | 35s | User gives one clear feature task to `nova-lead` → the lead brings `prism-ux`, `forge-dev`, and `sentinel-qa` into the same chat at different stages → UX and development working states show meaningful live progress before their replies → the verified pull request appears in the real GitHub sidebar section |
| `context-tree` | 59s | A concept-first Context-based Work Loop keeps the Tree Map as its visual anchor: relevant and authorized paths guide work → temporary detail stays with the code while the durable `system/billing/retry-ownership` decision is distilled → a dedicated Context Reviewer turns a candidate into an approved update → the new team snapshot serves multiple future Agents → the completed loop resolves into the real read/write-visible Context page and the promise that every task starts smarter |
| `github` | 31s | A repository-scoped GitHub App connects Issue / PR / review events to First Tree → an Issue assignment creates a Source-grouped Chat and wakes the assignee’s Delegate Agent → the linked PR, review feedback, updates, approval, and Merged / Closed state return to the same Chat |

Total: **125 seconds**.

## Install and preview

From the repository root:

```bash
pnpm install
pnpm --filter @first-tree/web exec playwright install chromium
pnpm --filter @first-tree/web video:preview
```

Then open:

```text
http://127.0.0.1:4178/preview/onboarding-orientation-video?chapter=multi-agent&frame=180
```

The registered chapter ids are `multi-agent`, `context-tree`, and `github`. `frame` is zero-based at 30fps.

## Render

Edit `chapters.json`, the single authoring source for chapter duration, narration timing, and spoken copy. Then generate
the committed narration tracks, review script, and matching VTT files with an approved Piper model:

```bash
ORIENTATION_PIPER_MODEL=/absolute/path/to/en_US-ljspeech-high.onnx \
  pnpm --filter @first-tree/web video:voiceover
```

This authoring command uses `uv`, Piper, FFmpeg, and FFprobe. It does not add a runtime dependency to Web.

To regenerate or verify only the derived text assets without a voice model:

```bash
pnpm --filter @first-tree/web video:voiceover:write-text
pnpm --filter @first-tree/web video:voiceover:check
```

Render every registered MP4, poster, and set of review stills:

```bash
pnpm --filter @first-tree/web video:render
```

Render one chapter while iterating:

```bash
pnpm --filter @first-tree/web video:render -- --chapter multi-agent
```

To use an already-installed Chromium-compatible browser instead of Playwright's managed browser:

```bash
ORIENTATION_VIDEO_BROWSER_EXECUTABLE=/absolute/path/to/chrome pnpm --filter @first-tree/web video:render
```

Parallel renders must use a unique strict Vite port per worktree:

```bash
ORIENTATION_VIDEO_PORT=4184 pnpm --filter @first-tree/web video:render -- --chapter multi-agent
```

The Context Tree chapter uses port 4181 while iterating:

```bash
ORIENTATION_VIDEO_PORT=4181 pnpm --filter @first-tree/web video:render -- --chapter context-tree
```

The script builds `@first-tree/shared`, opens the DEV-only recording route in Chromium, sets each frame deterministically, captures a lossless PNG in memory, and streams it directly to FFmpeg. It writes:

- MP4 and poster assets to `packages/web/public/onboarding/orientation/`
- first and key frames to `packages/web/orientation-videos/review/`

Master settings: a 1280×720 CSS viewport, 30fps, H.264 High Profile, yuv420p, slow preset with animation tuning, fast-start, and mono AAC narration at 48kHz / 96kbps. The approved Multi-agent chapter retains its 1.5× device-scale 1920×1080 output at CRF 18. Context Tree captures at 1.5× device scale, downsamples to 1280×720 with Lanczos, and uses CRF 16 so text and Tree lines remain crisp at the ordinary delivery resolution.

`orientation-videos/chapters.json` is the source of truth for duration, cue timing, and narration copy. The product chapter
registry imports its durations from that file and remains the source of truth for runtime asset paths. The recording page
exposes its frame rate and derived frame count to the renderer, so timing is not duplicated in the render script.

## Voiceover and captions

Each chapter has concise English narration with no music or decorative sound. The narration explains the product idea
while leaving quiet space for the viewer to inspect the real interface. Committed authoring tracks live in
`orientation-videos/voiceover/`; the renderer mixes the matching track into each MP4.

The current tracks use Piper's `en_US-ljspeech-high` US English voice, trained from the public-domain LJSpeech dataset.
`voiceover-script.md` is the generated human-review view of the approved cue timing and spoken copy; do not edit it directly.

Timed WebVTT files are accurate closed captions for the narration. They remain available from the native player but are
off by default so they do not cover the product UI, especially in the narrow mobile player. There is no separate
transcript UI.

## Edit copy or add a language

- Visible scene copy and timing: `src/pages/onboarding-orientation-video-preview.tsx` and the chapter scene file beside it
- Narration duration, timing, and spoken copy: `orientation-videos/chapters.json`
- Generated review copy: `orientation-videos/voiceover-script.md`
- Committed narration tracks: `orientation-videos/voiceover/*.m4a`
- English captions: `public/onboarding/orientation/*.vtt`

For a new language, add a localized narration track, separate VTT files, and a matching `<track>` per chapter. Render a separate localized video when visible scene copy is translated; do not mix two languages in one composition.

## Integration mapping

| Chapter id | MP4 | Captions | Poster |
| --- | --- | --- | --- |
| `multi-agent` | `/onboarding/orientation/multi-agent.mp4` | `/onboarding/orientation/multi-agent.vtt` | `/onboarding/orientation/stills/multi-agent-poster.png` |
| `context-tree` | `/onboarding/orientation/context-tree.mp4` | `/onboarding/orientation/context-tree.vtt` | `/onboarding/orientation/stills/context-tree-poster.png` |
| `github` | `/onboarding/orientation/github.mp4` | `/onboarding/orientation/github.vtt` | `/onboarding/orientation/stills/github-poster.png` |

`OnboardingOrientation` reads these stable paths directly. The native `<video>` includes narration and an opt-in caption track. Start / Skip, composer input, refresh recovery, and agent wake ordering are unchanged.

## Add another chapter

1. Add its metadata, duration, and asset paths to `ONBOARDING_ORIENTATION_CHAPTERS` in `src/components/chat/onboarding-orientation.tsx`.
2. Add its deterministic scene to `src/pages/onboarding-orientation-video-preview.tsx`.
3. Add its review keyframes and poster timestamp to `CHAPTERS` in `scripts/render-orientation-videos.mjs`.
4. Add the timed narration source to `orientation-videos/chapters.json`, generate its voiceover and VTT, render the MP4 and poster, and extend the component and route tests.
