# Cross-platform visual QA checklist

Use this checklist after any change to `index.css` `@theme`, component typography, spacing tokens, or the font pipeline. Run once per release on the four target browser × OS combinations.

## Target matrix

| OS | Browser | DPR | Priority |
|---|---|---|---|
| macOS | Chrome (latest) | 2x (Retina) | P0 |
| macOS | Safari (latest) | 2x | P0 |
| macOS | Firefox (latest) | 2x | P1 |
| Windows 11 | Chrome (latest) | 1.25x | P0 |
| Windows 11 | Edge (latest) | 1.5x | P0 |
| Windows 11 | Firefox (latest) | 1x | P1 |

Windows at non-integer DPI scale is the highest-risk environment — all P0 regressions show up there first. Do not sign off without testing at least one 1.25x and one 1.5x Windows viewport.

## Category 1 — Font pipeline

| Check | Pass criteria |
|---|---|
| Inter loads from `/fonts/inter-latin.woff2` (Network tab, 200 from same origin, no `fonts.googleapis.com`) | `inter-latin.woff2` requested; no Google Fonts request |
| `Inter Fallback` fires before Inter is parsed (visible in DevTools → Rendering → Emulate CSS Fonts: disable) | Layout does not shift when Inter finishes loading |
| Mac shows SF-like Inter with antialiased rendering | Letter spacing on "Workspace / Agents / Computers" top nav visually consistent with Figma |
| Windows shows Segoe UI fallback immediately, swaps to Inter with no FOUC shift | No noticeable layout jump; vertical rhythm of nav bar stable |
| CJK characters fall through to PingFang (Mac) and Microsoft YaHei (Win) | Chinese chat messages render without glyph boxes; no Times-like serif fallback |
| Disabling network → revisit page → fonts still render | Offline works because woff2 is bundled; system fallback after first render |
| `font-synthesis: none` in effect | Windows bold labels render true 600/700 stroke, not faux-bold smear |

## Category 2 — Typography tokens

| Check | Pass criteria |
|---|---|
| `text-eyebrow` uppercase labels | 10px, 600, `0.1em` tracking everywhere — no collapse to 9px or mixed weights |
| `text-caption` inline timestamps | 10px, 500, `0.06em` tracking — clearly lighter than eyebrow |
| `text-label` form labels + badges | 11px, 500, `0.02em` tracking — readable on Windows at 125% |
| `text-body` default body | 12px, 400, line-height 1.5 — most common; sanity-check across dense tables |
| `text-subtitle` section/card titles | 13px, 600, `-0.1px` tracking — clearly distinct from body but not title |
| `text-title` page titles | 16px, 600, `-0.2px` tracking — only appears in `<PageHeader>` and dialog titles |
| No Tailwind `text-xs/sm/base/lg/2xl` classes visible in computed styles | Run guardrail script: `pnpm --filter @first-tree/web lint:tokens` |

## Category 3 — Font-weight whitelist (400 / 500 / 600 / 700)

| Check | Pass criteria |
|---|---|
| No 100/200/300 anywhere (thin/extralight/light all disabled) | Windows 11 Chrome at 125% — no glyphs look "smeared" or broken-stroke |
| 500 medium used for: active nav item, `<BreadcrumbCurrent>`, mono identifiers, form labels | Weight visually one notch heavier than body (400) but not as heavy as semibold (600) |
| 600 semibold used for: panel titles, card titles, section headers, dialog titles | Hierarchy reads top-down without double-take |
| 700 bold reserved for: error badge counts, avatar initials, primary nav + submit button | Almost never appears in body content |

## Category 4 — Color tokens

| Check | Pass criteria |
|---|---|
| Dark-mode toggle flips all semantic colors | No white-on-white or black-on-black patches |
| `bg-error-soft / text-error / border-error` triple renders a red callout in light mode | Readable, not oversaturated |
| Same triple in dark mode uses softer bg (oklch 0.28) + lighter fg (oklch 0.82) | Readable without glare |
| `bg-warn-soft / text-warn / border-warn` — amber | Light: paper-colored soft bg; dark: warmer muted bg |
| `bg-success-soft / text-success / border-success` — green | Light + dark both |
| Dialog overlay uses `--color-overlay-scrim` (oklch 0 0 0 / 0.55), not `rgba(0,0,0,0.8)` | Same darkness in both themes |
| No hex / rgb / rgba literals in computed inline styles | `pnpm lint:tokens` passes |

## Category 5 — Spacing tokens

| Check | Pass criteria |
|---|---|
| Panel padding `var(--sp-2_5)` (10px) top/bottom, `var(--sp-3_5)` (14px) left/right | Rhythm consistent across Panels, SectionHeaders, DangerRows |
| Page container `var(--sp-3_5) var(--sp-5) var(--sp-7)` (14px 20px 28px) | Same breathing room on every top-level page |
| No raw `Npx` literal strings in any `.tsx` — scanned by guardrail | `pnpm lint:tokens` passes |

## Category 6 — Hairline borders (1px / 2px)

| Check | Pass criteria |
|---|---|
| All 1px borders use `var(--hairline)` in inline CSS | Searching `"1px solid"` in `src/**/*.tsx` returns 0 matches |
| All 2px borders (tabs active underline, danger zone left stripe) use `var(--hairline-bold)` | Same, for `"2px solid"` |
| Windows 11 @ 150% DPI — borders still visible, not anti-aliased away | Open DevTools → Rendering → Emulate DPR = 1.5; borders render as a faint 2-physical-pixel line |
| Dark mode borders use `--border-faint` for intra-panel separators and `--border` for Panel outlines | Separators barely visible; panel outlines clearly legible |

## Category 7 — Interactive states

| Check | Pass criteria |
|---|---|
| Button `default` variant (primary + foreground) | Contrast ≥ 4.5:1 in both modes |
| Button `destructive` uses `--color-destructive-foreground`, not raw `text-white` | Dark mode: destructive button fg is off-white (oklch 0.985), not pure white |
| Input `:focus-visible` ring uses `--accent-ring` (12% accent) | Visible on both light and dark backgrounds |
| Disabled button opacity 0.5 | Still readable, hover state not triggered |
| Dense table row hover uses `--bg-hover` | Subtle; not jarring against `--bg-raised` |

## Category 8 — Windows non-integer DPI specifics

These only surface on Windows at 125% / 150% DPI. Do not ship without this pass.

| Check | Pass criteria |
|---|---|
| 1px borders render as antialiased-but-visible line (inevitable at 1.25x, acceptable trade-off) | Not invisible; not 2px thick |
| 11px `text-label` still legible | No blurry edges on uppercase letters |
| 10px `text-eyebrow` readable with `font-weight: 600` + 0.1em tracking | Uppercase `REGISTERED`, `WORKSPACE`, etc. still crisp |
| `text-subtitle` letter-spacing `-0.1px` — not clamped to 0 | Title widths visually match Figma mocks |
| Scrollbar width matches Mac overlay scrollbar (via `scrollbar-width: thin`) | Column widths do not jump by ~15px when scrollbar appears |

## Running the guardrails

```bash
# Token/palette/weight guardrails (fast, < 1s):
pnpm --filter @first-tree/web lint:tokens

# Full build — also runs guardrails:
pnpm --filter @first-tree/web build

# Playwright visual diff (if installed):
pnpm --filter @first-tree/web test:visual
```

See `tests/visual-regression.spec.ts` for the Mac/Win viewport matrix the visual diff uses.
