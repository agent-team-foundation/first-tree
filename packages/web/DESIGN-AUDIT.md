# Design System Audit & Fix Log

> Recorded 2026-05-28 from a source-grounded review of `src/index.css` + `src/components/ui/*`.
> Companion to [DESIGN.md](DESIGN.md) (the spec) and `/preview/styleguide` (the visual reference).
>
> **This doc owns:** current implementation state, the gap vs DESIGN.md's adopted design
> language, the phased migration plan, the audit/fix log, and known structural gaps.
> DESIGN.md stays clean — the design system itself; everything time-bound or migration-related lives here.
>
> **Status legend:** `[ ]` open · `[~]` decision pending (needs owner) · `[x]` done.
> P0 items are live visual bugs (not style opinions) — they reference CSS variables that
> do not exist, so the property silently fails.

---

## Current shipped state (read this first)

The live design language is the **green-liveness status model** (next section), shipped in
**#672**, layered on **Strategy A**'s neutral chrome (Phase 0 + primitives, shipped in #662).
DESIGN.md already describes this end state.

Everything below dated **2026-05-28** — the Strategy A `Decisions`, `Implemented`, and the
`Strategy A migration` phase plan — is kept as a **historical fix-log**. Where a 2026-05-28
note records a colour that green-liveness later changed (notably `--state-working` cyan→green
and `--state-idle` neutral→blue), **the green-liveness section wins**; such lines are annotated
*(superseded by #672)*.

---

## Decisions (2026-05-29) — Green-liveness status model — SHIPPED in #672

Owner re-opened the color strategy to use green more boldly. Net change from the shipped
Strategy A (F): green is no longer "signature + success **only**" — it now also carries
**liveness**, while the neutral chrome and the no-green-on-dense-buttons discipline stay.
Shipped in **#672** (branch `refactor/web-green-liveness-main`).

- **Status palette re-coloured.** `--state-working` cyan → **green** (alive, pulses);
  `--state-idle` neutral-cool → **blue** (present/idle); added `--state-needs-you` =
  **amber**; `--state-blocked` → **orange** (warmer than needs-you, and the shared
  caution/warning hue). error=red, offline=gray unchanged. Cool (green/blue) = healthy;
  warm (amber/orange/red) = wants your attention, so problems pop against the live baseline.
- **working == success at the token level**, told apart by **form** (pulsing dot + glow vs
  a static ✓ glyph), not hue.
- **`--state-idle` disentangled.** It had doubled as the generic "✓ ok / ready / success"
  colour; those ~8 sites moved to `--success` (green) so idle could become a true
  presence-blue without turning every ✓ blue.
- **Liveness / arrival = green.** The new-message **divider** and **pill** went
  `--primary` → green — this **reverses** the Phase-0 choice that made them neutral
  (intentional). The selected conversation gets a **green left-rail + green-tint** (was
  neutral `--bg-active`). A soft green **glow** on the chat working chip.
- **Green hero CTA.** Added a `cta` Button variant (`bg-brand`), applied to the one
  creation/launch moment per surface (Create agent, onboarding Start). Dense/repeated
  actions stay neutral `default`.

---

## Decisions (2026-05-28)

Owner picked the optimization direction. These are now committed targets (implementation pending):

1. **Two named vocabularies, deduped values.** `--ok` / `--warn` / `--danger` are a *severity* triad
   (ok/warning/error, used in `context.tsx`), semantically distinct from agent-states even though the
   colors coincide. Introduce a proper **feedback set `--success` / `--warning` / `--danger`**; each
   (and the agent-`--state-*`) aliases to a single shared base hue, so there is **one value per color**.
   The root problem was duplicate *values*, not duplicate *names*. The severity triad migrates onto the
   feedback set; raw `--ok` is removed.
2. **`--state-idle` → neutral.** Break the `--accent` == `--ok` == `--state-idle` collision: idle becomes a neutral/de-saturated tone, visually distinct from brand green and success — but still distinct from `--state-offline`. *(Value being chosen by eye in `/preview/styleguide`: candidates A `oklch(0.72 0.02 150)` / B `oklch(0.70 0.03 240)` / C `oklch(0.68 0.05 150)`.)* **(superseded by #672:** `--state-idle` is now presence-**blue** `oklch(0.62 0.14 245)`, not neutral.)
3. **Radius → semantic only; shadow stays 2-tier.** Standardize radius on `--radius-*`; migrate the 38
   `rounded-md` (= 6px = `--radius-panel`, value-preserving) and `Dialog` `rounded-lg` (= 8px =
   `--radius-dialog`, value-preserving); `Badge` → `--radius-chip` (match DenseBadge). Retire shadcn
   `--radius-sm/md/lg/xl`. **Shadow:** keep the 2-tier `--shadow-sm/md` (no `--shadow-lg`); `Dialog`
   moves from Tailwind `shadow-lg` to `--shadow-md`.
4. **`--color-*` alias layer → delete.** `--fg` / `--bg-*` / `--border` are canonical. Remove the unadopted `--color-text-*`/`--color-surface-*`/`--color-border-*` layer (keep only the shadcn-compat aliases the primitives actually need, e.g. `--color-primary`, `--color-destructive`).

---

## Implemented (2026-05-28)

Verified after each stage with `pnpm --filter @first-tree/web typecheck` (tsc + `lint:tokens`):

- ✅ **P0** — all 7 ghost-token references fixed; the new guardrail then surfaced + fixed an 8th
  (`var(--shadow-lg)` in `attentions-section.tsx`).
- ✅ **P0.5** — undefined-token check added to `check-design-tokens.sh` (rule 7). Collects defined
  tokens from `index.css` + inline `"--foo"` definitions, diffs against every literal `var(--x)`
  (dynamic `var(--x-${…})` and `__tests__` excluded). Multi-line inline-style detection deferred.
- ✅ **P1** — removed `--ok/--warn/--danger`; added `--success`/`--warning`/`--danger` aliased to
  `--accent`/`--state-blocked`/`--state-error`; migrated all consumers (index.css + context.tsx).
  `--state-idle` → `oklch(0.7 0.03 240)` (cool standby) *(later → presence-blue `oklch(0.62 0.14 245)` by #672)*. Radius: 38 `rounded-md` + `rounded-lg/sm`
  → semantic `rounded-[var(--radius-*)]`, `Badge` → chip, `Dialog` `shadow-lg` → `--shadow-md`,
  removed `--radius-sm/md/lg/xl`.
- ✅ **P2 (partial)** — deleted the unadopted `--color-text-*/surface-*/border-*` alias layer
  (migrated `doc-preview-drawer.tsx`).
- Styleguide updated: real tokens, new Feedback swatches, idle shows the new tone; the temporary
  "Cleanup candidates" section was removed.

**Still open:** spacing rhythm, dead `--sp-*`, multi-line lint detection, and the ✓⚠✗⚙→lucide icon
purge (authed surfaces — needs a local-stack by-eye pass).
*(focus-ring extension — DONE: `filter-pill`/`tab-bar`/`segmented-control`; popover/command don't fit the ring.)*
*(DONE in the low-risk-tokens PR: `--text-live` drop, `--state-*-soft` companions, `color-scheme` on
`:root`/`.dark`, info callout — see P1/P2 marks. focus-ring unification — done in #662, see Phase 1.)*

---

## P0 — Ghost tokens (live bugs: referenced but undefined in index.css)

Each of these resolves to an invalid/empty value at runtime. Fix = point at the real token.

**RESOLVED (#656/#662)** — all 8 fixed (the 7 below + the stray `--shadow-lg`); `lint:tokens`
rule 7 (undefined-token) now stays green, so these can't silently regress.

| # | File:line | Written | Effect | Fix |
|---|-----------|---------|--------|-----|
| [x] 1 | `components/ui/toast.tsx:114` | `var(--surface-1)` | Toast background transparent | `--bg-raised` |
| [x] 2 | `pages/workspace/right-sidebar/attentions-section.tsx:89,167` | `var(--sp-0_25)` | Vertical padding collapses to 0 | `--sp-px` (1px) or `--sp-0_5` |
| [x] 3 | `pages/source-repos-settings-panel.tsx:161` | `var(--surface-2)` | Hover background no-op | `--bg-hover` |
| [x] 4 | `components/history-gap-banner.tsx:23` | `var(--fg-muted)` | Text color falls back to inherit | `--fg-3` |
| [x] 5 | `pages/workspace/conversations/new-chat-draft.tsx:451` | `var(--bg-base)` | Background transparent | `--bg` |
| [x] 6 | `pages/invite-accept.tsx:132` | `var(--destructive)` | Urgent color not applied | `--state-error` (or `text-destructive` util) |
| [x] 7 | `pages/agent-detail.tsx:692` | `fontSize: "var(--text-body-size)"` | Font size not applied **+** illegal inline `fontSize` | Use `text-body` class; drop inline `fontSize` |

**Done** — the stray `var(--shadow-lg)` (in `attentions-section.tsx`) was repointed to `--shadow-md`;
rule 9 now bans `shadow-(lg|xl|2xl)` so the 2-tier `--shadow-sm/md` scale stays enforced.

## P0.5 — Close the guardrail hole (highest leverage)

The token linter (`scripts/check-design-tokens.sh`) is line-based, so it missed both classes
of P0 bug. Two additions catch the entire P0 list automatically and stop recurrence:

- [x] **Undefined-token check (shipped — rule 7).** Collects every `var(--x)` in `src/`, diffs against
  the tokens defined in `index.css`; fails on any reference to an undefined token. (Caught all 7 above.)
- [ ] **Multi-line style detection (still deferred):** rules 1 (raw px) and 5 (inline font props) only match when
  `style={{` and the property are on the same line. `agent-detail.tsx:692` evaded both by spanning
  lines. Normalize whitespace before matching, or scan JSX style objects as blocks.

## P1 — Redundancy & contradiction (mostly RESOLVED — see marks)

- [x] **Duplicate color vocab.** `--ok` / `--warn` / `--danger` have byte-identical values to
  `--state-idle` / `--state-blocked` / `--state-error`. Two names per color = change-one-forget-other.
  **DECIDED + DONE:** removed `--ok/--warn/--danger`; severity migrated to the feedback set
  `--success` / `--warning` / `--danger` (aliased to `--accent` / `--state-blocked` / `--state-error`).
- [x] **Triple-identical green.** (was `--accent` == `--ok` == `--state-idle` == `oklch(0.72 0.17 150)` —
  brand/primary, "success", and "idle agent" visually indistinguishable.)
  **DONE:** `--accent` retired (→ `--primary` / `--brand`, #662); then #672 took `--state-idle` all the
  way to presence-**blue** `oklch(0.62 0.14 245)`. Brand-green, success, working, and idle are now four
  distinct, intentional roles.
- [x] **Two radius systems, both live.** Semantic `--radius-chip/input/panel/dialog` vs shadcn-legacy
  `--radius-sm/md/lg/xl`. `rounded-md` (legacy) is used **38×**; the flagship `Dialog`
  (`dialog.tsx:32`) uses `rounded-lg` + Tailwind `shadow-lg`, bypassing `--radius-dialog` /
  `surface-overlay` / the `--shadow-*` scale. `Badge` uses `rounded-md` while `DenseBadge` uses
  `--radius-chip`. **DONE (#662):** standardized on the semantic four; migrated `rounded-md`/`rounded-lg`,
  fixed `Dialog`/`Badge`, retired `--radius-sm/md/lg/xl` (rule 8 now bans `rounded-(sm|md|lg|xl)`).
- [x] **Near-dead token.** `--text-live` (32px tier) was referenced **once** — the `/preview/styleguide`
  demo — and **never in product**. **DONE:** removed the tier (the "Context tree is live" hero uses
  `.context-live-title`, not this tier).
- [x] **Inconsistent focus treatment.** **DONE (#662):** one recipe —
  `focus-visible:ring-2 ring-ring ring-offset-2` + a surface-matched `ring-offset` — applied across
  Button / Badge / Input / Dialog-close / Toast / settings-field. **Extended** to `filter-pill`,
  `tab-bar` (Tab), and `segmented-control`. `popover` triggers are caller-owned (already ringed via the
  `Button`/`FilterPill` passed in), and `command` (cmdk) uses its `aria-selected` highlight model with an
  always-focused input, so the button-style ring doesn't apply there.

## P2 — Omissions

- [x] **No `--state-*-soft` companions.** **DONE:** added
  `--state-{working,idle,needs-you,blocked,error,offline}-soft` (one canonical 14% translucent mix; raw
  on `:root`, `--color-state-*-soft` aliases in `@theme`). **`lib/tones.ts` + the ad-hoc call-site
  background fills (connect/disconnect chips, clients retire/load banners, agent-detail changed-chips)
  migrated onto them** — normalizing those fills to the canonical 14% (the only deltas: `tones.ts` warn
  16→14, and the call sites 12→14). Borders (28–38%) and `fg` (50–80%) stay `color-mix` — no `-line`/
  strong soft token exists yet (see P2 follow-up below). Still TODO: `.context-change-breakdown` (raw
  `oklch(.../0.12)` literals, and its "edited" swatch is hue 58) — folded into the `.context-*` palette PR.
  One deliberate hold-out: `chat-view` keeps a 6% error wash (fainter than `--state-error-soft`, by a
  solid error border), commented in place.
- [x] **`.dark` missing `color-scheme: dark`.** **DONE:** added `color-scheme: dark` to `.dark` (and
  `color-scheme: light` to `:root`); native form controls / scrollbars now match the canvas in both modes.
- [x] **`--color-*` semantic alias layer is unadopted.** `--color-text-*` / `--color-surface-*` /
  `--color-border-*` were each referenced once (only the styleguide). **DONE (#662):** deleted the alias
  layer; `--fg`/`--bg-*`/`--border` are canonical. Kept only the shadcn-compat aliases the primitives
  need (`--color-primary`, `--color-destructive`, `--color-ring`, etc.).
- [x] **Marketing surface contrast gap.** **DONE:** `.landing-marketing` now overrides the inline-callout
  pairs (`--bg/--fg-{error,warn,success,info}-*`) to their dark variants, so a notice on the near-black
  marketing canvas reads as a dark-surface notice instead of a bright light-mode card. The agent-state
  hues (`--state-*`) and `--state-*-soft` fills are mode-independent (alpha-composited), so they need no
  override. Styleguide marketing section now includes an inline-notice demo.
- [x] **No `info` (blue) callout pair.** **DONE:** added `--color-info` / `--color-info-soft` (blue hue
  245 — the presence-idle hue, following the same callout↔state hue pairing as error/warn/success),
  light + dark.

## P3 — Discipline

- [x] **`.context-live-*` is off-palette.** **DONE:** the hardcoded blue inks (255–265), faint-green
  card surfaces, brand-green fills, and the `.context-change-breakdown` chips are now a value-preserving
  `--context-*` token family in `:root` (reusing `--brand-bg` / `--state-*-soft` where exact). 1:1 lift —
  a later pass can rationalize the near-duplicate inks. Dark mode unchanged (the page is light-only; tokens
  are `:root`-only) — adding `.dark { --context-* }` overrides is now a trivial follow-up if the page
  should become dark-aware.
- [ ] **Spacing rhythm.** Half-steps (`--sp-1_25`=5px, `--sp-1_75`=7px) are used 12× / 23×, signalling
  pixel-nudging off a 4/8 rhythm. Converge to 4/8; mark half-steps as explicit exceptions.
- [x] **Prune dead `--sp-*`.** **DONE:** removed the 9 genuinely-unused tokens (verified 0 `var()`
  refs across `src/`, incl. index.css's own rules and the styleguide's dynamic swatch refs):
  `--sp-15`, `--sp-240`, `--sp-2_75`, `--sp-3_25`, `--sp-3_75`, `--sp-4_5`, `--sp-80`, `--sp-8_5`,
  `--sp-90`. (The earlier candidate list was stale — `--sp-16/20/45/60` are now in use; `--sp-0` kept as
  the ladder's zero anchor.) The half-step **rhythm normalization** (5px/7px → 4/8) is a *visual* change
  and stays open — it needs a by-eye pass.

---

## Structural gaps (longer-term, not blocking)

- **No animation token registry** — durations/easings are per-keyframe literals in `index.css`.
- **CLI (`apps/cli`) has no visual system** — plain commander + inquirer text; the design system covers the web surface only.

---

## Notes for whoever picks this up

- **Done:** P0, P0.5 rule 7, all P1 decisions, P2 `--color-*` alias (#656/#662); green-liveness colour (#672).
- **Still open (none blocking):** P0.5 multi-line detection, spacing rhythm,
  dead `--sp-*`, and the ✓⚠✗⚙→lucide icon purge (authed surfaces — local-stack by-eye pass). *(focus-ring
  extension is DONE for filter-pill/tab-bar/segmented-control. `--text-live` drop, `--state-*-soft`, `.dark`/`:root` color-scheme, and the
  info callout are DONE — see the P1/P2 marks above.)*
- Verify after any change: `pnpm --filter @first-tree/web typecheck` (runs tsc + `lint:tokens`).

---

## Strategy A migration (design-language adoption — 2026-05-28)

Adopted direction: **Strategy A** (see DESIGN.md → "Design language"). Migrate the app
from green-primary to **neutral-primary + green-as-signature/semantic**, at Lark/Arco
craft level. Reference mockup: `variant-F.html` (light + dark) in the design archive.
This is a full visual pass — do it phased, not in one shot. The earlier P1–P3 leftovers
fold into the phases below.

**Pre-Phase-0 decisions (RESOLVED 2026-05-28):**
- [x] **Gray ramp temperature → pure neutral (chroma 0).** De-tinted the former
  hue-150 / low-chroma neutrals so grays never read faintly green next to the brand.
  Decided by eye against a tinted-vs-neutral comparison; pure neutral made the brand
  green pop *more* by contrast.
- [x] **`--primary` values.** Light `oklch(0.21 0 0)` / hover `0.32` / on `0.99`;
  dark `0.93` / hover `0.85` / on `0.17`. Added a neutral `--ring` (primary @ 0.4 alpha).
  Dedicated token set (not a reuse of `--fg`) so action-ink can diverge from body text.
- [x] **Token naming → rename in one pass, no alias.** Retired `--accent` entirely;
  renamed the green to `--brand` (+ `--brand-dim` / `-bg` / `-ring`); kept `--success`
  (= `--brand`); introduced neutral `--primary`. Every `var(--accent*)` was reclassified
  per-site (≈90 sites): most → `--primary`; logo / mentions / avatar-fallback / admin
  badge / agent-chip → `--brand`; healthy / active-sessions / pulse → `--success`.
  Selection fills → `--bg-active`. `shadcn`'s `--color-accent` (neutral hover surface)
  and the `"accent"` tone identifier are intentionally kept — neither contains the
  `--accent` substring, so the guardrail leaves them alone.

**Phase 0 — token role refactor (`index.css`) — DONE 2026-05-28:**
- [x] Added `--primary` / `--primary-hover` / `--primary-on` / `--ring` (auto-inverting `:root` / `.dark`).
- [x] Repointed primary actions / active / selected / focus / links: `--accent` → `--primary`.
- [x] Renamed `--accent` → `--brand` (logo / mentions / avatar fallback / signature); `--success` → `--brand`.
- [x] Selected / active states → neutral fill (`--bg-active` / `--primary`), not green tint. *(#672 later
  reverted the **selected conversation** to a green left-rail + green-tint for liveness; tabs and other
  selections stay neutral.)*
- [x] De-tinted the neutral ramp to chroma 0 (decision 1), light + dark.
- [x] Guardrail **rule 10** bans the retired `--accent` family to force completeness.
- [x] Updated `/preview/styleguide` swatches (split into Primary / Brand groups); verified light + dark.
- [x] (cleanup) status palette set — *(superseded by #672 green-liveness: now working=**green**,
  idle=**blue**, needs-you=**amber**, blocked=**orange**, error=red, offline=gray.)*

**Phase 1 — primitives (`components/ui/`) — DONE (#662):**
- [x] `Button`: default variant neutral-primary (via Phase 0 tokens); flat (removed the
  Tailwind-default `shadow`) for the crisp Arco look; default hover wired to `--primary-hover`.
- [x] Flatten / tokenize primitive shadows to the flat reference: `badge` + `input` flat;
  `card` → `shadow-[var(--shadow-sm)]`; `row-actions-menu` → `shadow-[var(--shadow-md)]`.
- [x] **Unify the focus-ring recipe** → one accessible form
  (`focus-visible:ring-2 ring-ring ring-offset-2` + a surface-matched `ring-offset` color)
  across Button / Badge / Input / Dialog-close / Toast / settings-field (theme-toggle
  already conformed). Fixes the invisible-ring-on-`--primary`-fill bug; `ring-offset` color
  matches each control's real surface (`--bg-sunken` for settings-field, `--bg-raised` for toast).
- [ ] **Follow-ups (deferred):**
  - Line-icon set / purge the ✓ ⚠ ✗ ⚙ glyphs in favor of lucide — layout-affecting, spread
    across pages (`runtime-state-line`, `working-turn`); needs a by-eye pass on authed surfaces
    (not reachable from the styleguide), so deferred to a local-stack session. **Still open.**
  - [x] Extend the focus ring to the remaining interactive primitives — **DONE** for `filter-pill` /
    `tab-bar` / `segmented-control`; `popover` trigger is caller-owned and `command` uses cmdk
    `aria-selected` (neither fits the button ring), so the recipe is now applied everywhere it makes sense.
  - Button/Badge base `ring-offset-background` uses the page surface; on a raised card/menu
    a sub-perceptible 2px seam can appear on keyboard focus (a primitive can't know its
    parent surface). Masked by the filled fill; acceptable until a per-surface convention exists.
  - Component-grammar restyle (Tabs, ConversationList, ChatView, etc.) is Phase 2.

**Phase 2 — component grammar (workspace):**
- [ ] `ConversationList`: add a Search box; tabs-as-underline; rounded-square avatars. *(#672 already
  shipped the green-rail selected conversation + the new-message divider/pill.)*
- [ ] `ChatView`: neutral "you" bubble; neutral send button; **green** working chip (glow) — per #672.
- [ ] Right **Session sidebar**: agent card + Runtime/Model KV + Live-context tree nodes (green) + Needs-you.

**Phase 3 — rollout + folded cleanup:**
- [ ] Apply across remaining pages (Team roster, Settings, onboarding, …).
- [x] Add `--state-*-soft` tokens — DONE (definitions + `tones.ts`/call-site migration). *(`.context-change-breakdown` still raw — folded into the `.context-*` palette PR. Follow-up idea: add `--state-*-line` (~30%) border tokens so the borders that still hand-roll `color-mix` can converge too.)*
- [x] `color-scheme: dark` on `.dark` — DONE; the off-palette `.context-live-*` blues are now in the `--context-*` token family — DONE.

**Phase 4 — close-out:**
- [ ] QA in light + dark.
- [x] `/preview/styleguide` renders the new language (updated in #672).
- [x] DESIGN.md §3 (Color) rewritten to the now-implemented green-liveness language (#672); no
  "migration in progress" caveats remain. *(§8 Iconography — the ✓ ⚠ ✗ glyph→lucide purge — is still
  the deferred Phase-1 follow-up.)*
