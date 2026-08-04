# First-chat Orientation videos

A deterministic product demonstration rendered from the real First Tree Web design system. The recording route uses fixed local fixtures: it does not sign in, call the API, or modify onboarding state.

## Shot list

| Chapter | Duration | Shots |
| --- | ---: | --- |
| `multi-agent` | 35s | User gives one clear feature task to `nova-lead` → the lead brings `prism-ux`, `forge-dev`, and `sentinel-qa` into the same chat at different stages → UX and development working states show meaningful live progress before their replies → the verified pull request appears in the real GitHub sidebar section |

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

The currently registered chapter id is `multi-agent`. `frame` is zero-based at 30fps.

## Render

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

The script builds `@first-tree/shared`, opens the DEV-only recording route in Chromium, sets each frame deterministically, captures a lossless PNG in memory, and streams it directly to FFmpeg. It writes:

- MP4 and poster assets to `packages/web/public/onboarding/orientation/`
- first and key frames to `packages/web/orientation-videos/review/`

Master settings: a 1280×720 CSS viewport captured at 1.5× device scale for a 1920×1080 output, 30fps, H.264
High Profile, yuv420p, CRF 18, slow preset with animation tuning, fast-start, and no audio.

The product chapter registry is the source of truth for duration and asset paths. The recording page exposes its frame rate and derived frame count to the renderer, so timing is not duplicated in the render script.

## Audio and captions

The v1 videos intentionally have no spoken voiceover. They play inside a chat, where silent viewing is common, and
voice audio would add localization and update coupling. Timed WebVTT captions plus the inline transcript are the
authoritative explanation layer; the visual story must remain understandable without sound.

## Edit copy or add a language

- Visible scene copy and timing: `src/pages/onboarding-orientation-video-preview.tsx`
- English captions: `public/onboarding/orientation/*.vtt`
- Inline transcripts: `src/components/chat/onboarding-orientation.tsx`

For a new language, add separate VTT files and a matching `<track>` per chapter. Render a separate localized video only when visible scene copy is translated; do not mix two languages in one composition.

## Integration mapping

| Chapter id | MP4 | Captions | Poster |
| --- | --- | --- | --- |
| `multi-agent` | `/onboarding/orientation/multi-agent.mp4` | `/onboarding/orientation/multi-agent.vtt` | `/onboarding/orientation/stills/multi-agent-poster.png` |

`OnboardingOrientation` reads these stable paths directly. The only product change is replacing the selected chapter's placeholder with a native `<video>` element and caption track. Start / Skip, composer input, refresh recovery, and agent wake ordering are unchanged.

## Add another chapter

1. Add its metadata, duration, asset paths, and transcript to `ONBOARDING_ORIENTATION_CHAPTERS` in `src/components/chat/onboarding-orientation.tsx`.
2. Add its deterministic scene to `src/pages/onboarding-orientation-video-preview.tsx`.
3. Add its review keyframes and poster timestamp to `CHAPTERS` in `scripts/render-orientation-videos.mjs`.
4. Add the VTT captions, render the MP4 and poster, and extend the component and route tests.
