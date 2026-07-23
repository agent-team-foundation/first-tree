# First Tree — Web Design System

> Source of truth for the React admin dashboard (`packages/web`).
> Distilled from the live system: [`src/index.css`](src/index.css),
> [`src/components/ui/`](src/components/ui), and
> [`scripts/check-design-tokens.sh`](scripts/check-design-tokens.sh).
>
> **One rule above all:** components never hardcode color, size, spacing, or
> typography. Everything references a token defined in `index.css`. This is not
> a style guideline — it is enforced by a linter that fails the build (see
> [Enforcement](#enforcement)).

---

## Design language

> Implementation status, the gap vs the current build, and the step-by-step
> migration plan live in **[DESIGN-AUDIT.md](docs/DESIGN-AUDIT.md)**. This document
> describes the design system itself.

**Four pillars:**

1. **Near-monochrome, content-first.** The UI is grays + near-black / near-white.
   Color is rare and always *means* something — it never decorates.
2. **Neutral primary, green hero.** Everyday actions (buttons, send, menus,
   selected tabs, links) use a **neutral** tone — near-black in light,
   near-white in dark (auto-inverting). The one exception is the *hero /
   creation* moment per surface ("Create agent", onboarding "Start", marketing
   CTA), which uses the brand-green `cta` button variant. Dense or repeated
   actions never go green — that's the green-primary (E2) collision.
3. **Green = the living system.** Brand green carries three related jobs —
   brand signature (logo, Context-Tree nodes, @mentions), **success** (✓,
   "ready to merge"), and **liveness** (a working agent pulses green; live
   arrivals — the new-message pill + divider — are green). Working-green is told
   apart from success-green by **form** (pulsing dot + glow vs a static ✓
   glyph), not hue. The states that want your attention are **warm** so they pop
   against the green/blue live baseline: needs-you (your action / unsaved) =
   amber, blocked = orange, error = red. Present-but-idle = blue; offline =
   gray. Where several attention states share one dense surface — the
   conversation-list corner mark — they collapse to a single attention red and
   are told apart by *form* (failed `!` / needs-you `?` / unread plain dot),
   because hue is unreliable at a 9–13px badge (form over hue again).
4. **Mature collaboration craft, not borrowed color.** Borrow the *discipline*
   — a neutral gray token ramp, hairline borders, soft low-opacity elevation,
   thin line icons, search + underline tabs, rounded-square avatars,
   comfortable aligned spacing, a right Session sidebar. Do **not** borrow a
   saturated blue primary.
5. **Card chrome = interactivity.** A filled or bordered card signals that
   something is selectable or actionable. Read-only / informational states
   (status readouts, confirmations) render as plain labeled content, **not**
   wrapped in a filled/bordered card.

**Semantic color map — the only places color appears:**

| Meaning | Color |
|---------|-------|
| everyday action / selected tab | neutral (near-black ↔ near-white) |
| hero / creation CTA | green (`cta` variant — sparingly) |
| brand / Context-Tree / @mention | green (`--brand`) |
| success / passing / done | green (`--success`) |
| working / alive (pulses + glow) | green (`--state-working`) |
| live arrival (new-message pill + divider) | green |
| selected conversation (liveness) | green (left-rail + tint — distinct from a selected *tab*, which stays neutral) |
| idle / present | blue (`--state-idle`) |
| needs you / unsaved (your action) | amber (`--state-needs-you`) |
| blocked / stuck | orange (`--state-blocked`) |
| error / failed | red (`--state-error`) |
| offline | dim gray (`--state-offline`) |

Per-agent **avatars** keep their own identity hues (wayfinding, not brand).

---

## 1. Principles

- **Single source of truth.** `index.css` is the only file allowed to define
  raw values. Every other file in `src/` references tokens. `index.css` is the
  one file exempt from the guardrail scan.
- **Semantic over raw.** Components reference *intent* (`text-secondary`,
  `surface-raised`, `state-error`) — not appearance (`gray-500`, `#fff`,
  `red-600`). Re-theming happens in one place.
- **Dense by default.** This is a control-room dashboard for agent teams, not a
  marketing site. The type scale tops out at 16px for app chrome; large type is
  reserved for the public landing surface.
- **OkLCH everywhere.** All colors are authored in OkLCH for perceptual
  uniformity — matched lightness/chroma reads with consistent visual weight
  across hues, and light↔dark inversion stays balanced.
- **Cross-platform stable.** Self-hosted fonts, fallback metric-matching, and
  a CSS spacing ladder keep rendering identical on macOS / Windows / Linux and
  offline.

---

## 2. Enforcement

`pnpm --filter @first-tree/web lint:tokens` runs as part of `typecheck` and
fails the build on the first violation. It bans, across all `*.ts` / `*.tsx`
in `src/` (except `index.css`):

| # | Banned | Use instead |
|---|--------|-------------|
| 1 | Raw `Npx` literals | `--sp-*`, `--hairline`, or Tailwind spacing utilities |
| 2 | `#hex`, `rgb()`, `rgba()` | `--color-*` tokens / `oklch()` |
| 3 | Tailwind palette classes (`text-gray-500`, `bg-red-50`, …) | semantic color tokens |
| 4 | font-weights outside 400/500/600/700 | the four allowed weights |
| 5 | Inline `fontSize`/`fontWeight`/`fontFamily`/`lineHeight`/`letterSpacing` | `text-*` tier + `font-*` class |
| 6 | Tailwind default text sizes (`text-sm`, `text-xl`, …) | the 6-tier semantic scale |
| 7 | `var(--x)` referencing a token **not defined** in `index.css` (ghost tokens) | define it in `index.css`, or fix the name |
| 8 | Tailwind default radius classes (`rounded-sm/md/lg/xl`) | `rounded-[var(--radius-chip\|input\|panel\|dialog\|full)]` |
| 9 | Tailwind shadows above the 2-tier scale (`shadow-lg/xl/2xl`) | `shadow-[var(--shadow-sm\|md)]` |
| 10 | The retired `--accent` family (`--accent`, `--accent-dim/-bg/-ring`) | `--primary` for actions/active, `--brand` for signature green |

If you need a value the tokens don't cover, **add a token to `index.css`** —
don't inline the literal.

---

## 3. Color

Defined as raw values on `:root` (light) and `.dark` (dark), then exposed
through semantic aliases in the Tailwind v4 `@theme` block. Components only
ever touch the semantic layer.

### Primary & brand
| Token | Value | Role |
|-------|-------|------|
| `--primary` | neutral — near-black (light) / near-white (dark), auto-inverting | everyday actions, send, selected tabs, links |
| `--brand` | green `oklch(0.72 0.17 150)` | logo, Context-Tree, @mentions, success, liveness (working / arrival), and the hero `cta` button — **never** a dense / repeated action color |

Color is sparse and meaningful: most of the UI is neutral, and the green only
appears where it signals brand, success, or a *living* system (a working agent,
a fresh arrival).

The short `--fg*` / `--bg*` / `--border*` names below are canonical; write those.

### Text (foreground)
`--fg` (primary) → `--fg-2` (secondary) → `--fg-3` (tertiary) → `--fg-4`
(disabled). Four steps, descending emphasis. `--fg-on-vivid` (near-white) is
for text sitting on a saturated colored surface (badges, avatars) and does
**not** invert in dark mode.

### Surfaces (background)
`--bg` (base) · `--bg-raised` · `--bg-sunken` · `--bg-hover` · `--bg-active`.

### Borders
`--border-faint` (subtle) · `--border` (default) · `--border-strong` (emphasis).

### State / status (agent-centric)
| Token | Hue | Meaning |
|-------|-----|---------|
| `--state-working` | green `150` | alive / working — pulses (+ glow on the chat chip); told apart from success by form, not hue |
| `--state-idle` | blue `245` | present / idle (at rest) |
| `--state-needs-you` | amber `75` | your action needed / unsaved — distinct from blocked orange; ships a `-soft` fill + `--fg-needs-you-strong` AA text companion (draft chip, tab unsaved dot, open-question REQUEST chip) |
| `--state-blocked` | orange `58` | blocked / stuck — also the shared caution / warning hue |
| `--state-error` | red `25` | error / failed |
| `--state-offline` | dim gray | offline |
| `--state-unread` | = error | notification/attention (kept separate identifier on purpose) |

> **Conversation-list corner mark is the one place these don't carry their own
> hue.** failed / needs-you / unread collapse to a single attention **red** and
> are told apart by glyph (`!` / `?` / plain dot) — see [§7](#7-components) /
> `chat-row-avatar.tsx`. Everywhere else (chips, dots, tints) each state keeps
> its semantic hue.

Each state also ships a **soft** companion fill — `--state-working-soft` …
`--state-offline-soft` (one canonical 14% translucent mix). Use these for
state-tinted surfaces (chips, wells, `.context-change-breakdown`) instead of
hand-rolling `color-mix(... var(--state-*) ..., transparent)` at the call site.

### Capability readiness (Setup)

Capability readiness is not agent presence. Setup rows keep the capability
icon neutral and render a separate Lucide status glyph, so state remains clear
without relying on color:

| Meaning | Glyph | Token |
|---------|-------|-------|
| ready / verified | static `CircleCheck` | `--success` |
| optional / not configured / off | `CircleMinus` | `--fg-4` |
| verification pending | static `Clock3` | `--state-idle` |
| current viewer can resolve it | `CircleAlert` | `--state-needs-you` |
| degraded / blocked elsewhere | `CircleAlert` | `--state-blocked` |
| status could not be checked | `CircleHelp` | `--fg-3` |

A transient request may use `LoaderCircle` with a reduced-motion-safe spin;
long-lived verification never spins. Use amber only when explicit ownership
or personal scope establishes that the current viewer can resolve the issue;
role or a generic Manage link alone is not enough. Red is reserved for a
confirmed failed operation or system error, normally in an inline callout; a
failed status query is neutral unknown, never evidence that the capability
itself is unavailable.

The visible label and detail are the semantic source; readiness glyphs are
decorative (`aria-hidden`). Static row readouts do not each get an `aria-live`
region. Do not reuse agent-centric `StateDot` / `StatusGlyph` for this
vocabulary, and do not mechanically map backend health enums to color without
considering adoption, blockers, resolution owner, role, and user impact.

### Feedback / severity
A named set, aliased to shared base hues (one value per color):
`--success` (green, = brand hue) · `--warning` (orange, = `--state-blocked`; the caution/blocked hue) · `--danger` (red).

### Inline callouts (notices)
Each state ships a **soft** background + a **strong** text/border tone, so you
never reach for `bg-red-50 / text-red-900`:
`--color-error` / `--color-error-soft`, `--color-warn` / `--color-warn-soft`,
`--color-success` / `--color-success-soft`, and `--color-info` /
`--color-info-soft` (blue, hue 245 — the presence-idle hue, following the same
callout↔state hue pairing; for **static** informational notices, not the
dynamic working/idle agent state).

### Overlay
`--color-overlay-scrim` — dialog/lightbox scrim (`oklch(0 0 0 / 0.55)`,
uniform in both modes). Replaces hardcoded `rgba(0,0,0,…)`.

### shadcn-compat aliases
`--color-background/foreground/card/primary/secondary/muted/destructive/
border/input/ring` are preserved so shadcn-shaped components keep working —
prefer the short semantic names above in new code.

---

## 4. Typography

Six dense tiers for app chrome (each bundles size + line-height +
letter-spacing + weight), generating `.text-eyebrow … .text-title` utilities.
Three marketing tiers for the public landing page only.

| Tier | Size | Weight | Typical use |
|------|------|--------|-------------|
| `text-eyebrow` | 10px | 600 | all-caps kickers (0.1em tracking) |
| `text-caption` | 11px | 500 | dense metadata |
| `text-label` | 12px | 500 | form labels, chips |
| `text-body` | 13px | 400 | body copy, buttons |
| `text-subtitle` | 14px | 600 | row titles (**default body size**) |
| `text-title` | 16px | 600 | section / page titles |
| — marketing — | | | |
| `text-lead` | 18px | 400 | landing lead copy |
| `text-headline` | 24px | 600 | landing section headings |
| `text-display` | `clamp(2.5rem, 6vw, 3.75rem)` | 600 | landing hero |

**Only weights 400 / 500 / 600 / 700 exist.** Numerics use `tabular-nums`
(`.tnum`); mono uses `--font-mono` with `ss01/ss02` features.

---

## 5. Spacing & radius

**Spacing** — Tailwind utilities first; for compound inline `padding`/`gap`
strings that can't be classes, use the `--sp-*` ladder (mirror of Tailwind:
`--sp-N ≈ N × 0.25rem`, with 2/6/10/14px half-steps), range `--sp-0` →
`--sp-95` (380px) — dense through `--sp-12`, then sparse wider rungs
(`--sp-16/20/35/45/60/70/75/95`) for panel / card widths. Hairlines:
`--hairline` (1px) / `--hairline-bold` (2px) — never write `"1px"`.

**Radius** — semantic, ascending with surface importance, plus one fully-round token:
| Token | Value | Use |
|-------|-------|-----|
| `--radius-chip` | 3px | chips, pills, xs buttons |
| `--radius-input` | 4px | inputs, default buttons |
| `--radius-panel` | 6px | cards, panels |
| `--radius-dialog` | 8px | dialogs, overlays |
| `--radius-full` | 9999px | fully-round — circular discs/dots, avatar rings, capsule pills |

The first four ascend with surface importance; `--radius-full` is the odd one out —
it means "circle/capsule", not a size. These five are the only radius tokens —
reference them directly (`rounded-[var(--radius-panel)]`) or via the matching utilities.
Never hardcode a radius (`borderRadius: 999` / `"50%"`) — use `--radius-full`.

---

## 6. Surfaces & elevation

Three utility classes consolidate the background+border+radius+shadow combos
(prefer these over hand-rolling):

- `.surface-raised` — raised bg + 1px border + `--radius-panel` (cards/panels)
- `.surface-sunken` — recessed bg (wells, inset areas)
- `.surface-overlay` — raised bg + border + `--radius-dialog` + `--shadow-md`
  (dialogs, popovers)

Shadows are tokens: `--shadow-sm`, `--shadow-md` (deeper in dark mode).

---

## 7. Components

~31 primitives in [`src/components/ui/`](src/components/ui), built on
**Radix** (Dialog, Label, Slot, Popover) + **CVA** for variants +
`cn()` (clsx + tailwind-merge) for class composition. No shadcn/MUI/Chakra —
this is a bespoke system on Tailwind v4 + Radix.

**Variant pattern** (every variant-bearing component follows this — see
[`button.tsx`](src/components/ui/button.tsx),
[`badge.tsx`](src/components/ui/badge.tsx)):

```ts
const buttonVariants = cva("…base classes…", {
  variants: { variant: { default, destructive, outline, secondary, ghost, link },
              size:    { default, sm, xs, lg, icon } },
  defaultVariants: { variant: "default", size: "default" },
});
```

`Button` sizes: `default` (h-9) · `sm` (h-8) · `xs` (h-7, chip radius) ·
`lg` (h-10) · `icon` (9×9). `asChild` via Radix `Slot`.

**Inventory** (representative):
- **Actions / inputs:** Button, Input, Label, SegmentedControl, FilterPill,
  OptionCard, Command (cmdk), RowActionsMenu
- **Containers / layout:** Card, Panel, Section, Tile, SettingsField, PageHeader,
  SectionHeader, FlatSectionHeader, TabBar
- **Data:** Table, DenseTable, Breadcrumb, Markdown
- **Status / presence:** Badge, DenseBadge, StateChip, StateDot, StatusGlyph,
  PresenceChip, AgentStatusChip
- **Overlay / feedback:** Dialog, Popover, Toast
- **Theming:** ThemeToggle

**Selection state** (`OptionCard` and any radio/option cards): selected and
unselected share the **same faint `--border` hairline** — selection is signalled
by a **filled neutral dot (`--fg`) plus a light `--fg` tint (~10%) plus medium
label weight**, never a heavier or colored border and never a saturated dot.
Both cues are hue-independent (filled vs hollow dot, presence of tint), so it
reads without relying on color. The real `<input>` is `sr-only`; focus follows
the §13 bordered-control rule (deepen the card's own border on `:focus-within`).

---

## 8. Iconography

`lucide-react` only — single icon set, no custom glyphs or icon fonts. Keeps
stroke weight and sizing consistent everywhere.

---

## 9. Motion

Keyframes live in `index.css` (not inline) so `prefers-reduced-motion` can
override them — **every animation has a reduced-motion fallback**. Vocabulary:

- **Status pulses** — opacity-led dot breathing (no concentric rings, so a
  roster column stays pixel-aligned): `--working` 1.4s ("alive").
- **Arrival** — `.fade-in` (180ms rise), `toast-slide-in`, feed slide+flash on
  fresh rows.
- **Live/ambient** — halo breathe, ring pulse, typing-dot wave for "producing
  output now".
- **Standard easing** — `ease-out` for entrances; `cubic-bezier(0.2,0.8,0.2,1)`
  for slides. Transitions ~120–180ms.

---

## 10. Theming

Class-based: `.dark` on `<html>`, persisted to `localStorage`, falling back to
`prefers-color-scheme`. Toggle in [`theme-toggle.tsx`](src/components/ui/theme-toggle.tsx).

Three palettes share the **same variable names** (so every utility inherits
automatically):
1. **Light** (`:root`) — near-white pure-neutral canvas (chroma 0), dark ink.
2. **Dark** (`.dark`) — pure-neutral near-black, light ink; deeper shadows;
   higher-lightness callout text for contrast.
3. **Marketing** (`.landing-marketing`) — pinned to the first-tree.ai brand:
   near-black `#040404` canvas + cool-tinted light text, regardless of the
   dashboard toggle. `color-scheme: dark`. Same green brand.

Each palette declares `color-scheme` (`light` on `:root`, `dark` on `.dark` and
`.landing-marketing`) so native form controls, scrollbars, and `<input>` widgets
render in the matching mode.

---

## 11. Fonts

Self-hosted variable woff2 from `/public/fonts` (no Google Fonts network dep,
no FOUT flash, works offline). Latin + Latin-Extended subsets; CJK falls
through to system fonts.

- **Sans:** Inter (400–700) → `Inter Fallback` (Arial, metric size-adjusted for
  FOUT stability) → system stack (incl. PingFang SC / Microsoft YaHei for CJK).
- **Mono:** JetBrains Mono (400–600) → ui-monospace stack.

Body defaults: 14px / 1.45, `cv11 ss01 ss03` features, `tabular-nums`,
antialiased, `font-synthesis: none`.

---

## 12. Avatars

Per-agent identity color: 8 perceptually-balanced OkLCH hues
(`--avatar-hue-0…7`, matched L/C) at the same visual weight. Same agent →
same hue everywhere, via `pickAvatarHue(agentId)` /
`resolveAvatarHue()` (manager-set token, else deterministic hash of agentId).
White-ish initials (`--fg-on-vivid`) clear WCAG AA on every hue in both modes.
**Add new hues in the `index.css` block, not at the call site.**

---

## 13. Accessibility

- `--fg-on-vivid` initials and callout pairs are AA-checked in both themes.
- Every animation respects `prefers-reduced-motion: reduce`.
- Radix primitives provide focus management / ARIA for Dialog, Popover, Label.
- Focus is visible but restrained, in two flavors so nothing ever reads as a
  double frame. The rule is **by whether the control has a visible resting
  border**, not by component type:
  - **Anything with its own border** — text inputs (`Input`), radio/checkbox
    cards (`OptionCard`, on `:focus-within`, real input `sr-only`), and the
    `outline` Button — darkens that border to `--ring` on focus
    (`focus-visible:border-ring`, ring cancelled). One line, no offset gap.
  - **Borderless controls** (filled/ghost Button, Badge, Dialog-close, Toast,
    settings-field's filled field) use one thin neutral ring —
    `focus-visible:ring-1 ring-ring ring-offset-1` — which has no resting border
    to double with.
  - `--ring` is a neutral near-fg hue, never a saturated accent.
- Scrollbars are styled thin/consistent cross-platform to avoid layout jump.

---

## 14. Extending the system

1. **Need a new value?** Add a token to `index.css` — never inline a literal.
   Put it in the right block (`@theme` for utility-generating tokens, `:root` /
   `.dark` for raw mode-specific values).
2. **Need a new component?** Build it in `src/components/ui/`, compose with
   `cva` + `cn`, reference Radix for any interactive/overlay behavior, and only
   use tokenized classes.
3. **Re-run the guardrail:** `pnpm --filter @first-tree/web lint:tokens`.
4. **Color authoring is OkLCH.** Keep lightness/chroma matched to neighbors so
   visual weight stays even.

---

## Status & roadmap

Current implementation status, the gap vs this design language, the phased
migration plan, and known gaps all live in **[DESIGN-AUDIT.md](docs/DESIGN-AUDIT.md)**.

**Visual reference:** the living styleguide at `/preview/styleguide`
(`src/pages/styleguide-preview.tsx`).
