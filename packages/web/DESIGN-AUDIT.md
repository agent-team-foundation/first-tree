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

## Decisions (2026-05-28)

Owner picked the optimization direction. These are now committed targets (implementation pending):

1. **Two named vocabularies, deduped values.** `--ok` / `--warn` / `--danger` are a *severity* triad
   (ok/warning/error, used in `context.tsx`), semantically distinct from agent-states even though the
   colors coincide. Introduce a proper **feedback set `--success` / `--warning` / `--danger`**; each
   (and the agent-`--state-*`) aliases to a single shared base hue, so there is **one value per color**.
   The root problem was duplicate *values*, not duplicate *names*. The severity triad migrates onto the
   feedback set; raw `--ok` is removed.
2. **`--state-idle` → neutral.** Break the `--accent` == `--ok` == `--state-idle` collision: idle becomes a neutral/de-saturated tone, visually distinct from brand green and success — but still distinct from `--state-offline`. *(Value being chosen by eye in `/preview/styleguide`: candidates A `oklch(0.72 0.02 150)` / B `oklch(0.70 0.03 240)` / C `oklch(0.68 0.05 150)`.)*
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
  `--state-idle` → `oklch(0.7 0.03 240)` (cool standby). Radius: 38 `rounded-md` + `rounded-lg/sm`
  → semantic `rounded-[var(--radius-*)]`, `Badge` → chip, `Dialog` `shadow-lg` → `--shadow-md`,
  removed `--radius-sm/md/lg/xl`.
- ✅ **P2 (partial)** — deleted the unadopted `--color-text-*/surface-*/border-*` alias layer
  (migrated `doc-preview-drawer.tsx`).
- Styleguide updated: real tokens, new Feedback swatches, idle shows the new tone; the temporary
  "Cleanup candidates" section was removed.

**Still open:** focus-ring unification, `--text-live` adopt/drop, `--state-*-soft` companions,
`color-scheme: dark` on `.dark`, info callout, `.context-live-*` palette, spacing rhythm, dead `--sp-*`.

---

## P0 — Ghost tokens (live bugs: referenced but undefined in index.css)

Each of these resolves to an invalid/empty value at runtime. Fix = point at the real token.

| # | File:line | Written | Effect | Fix |
|---|-----------|---------|--------|-----|
| [ ] 1 | `components/ui/toast.tsx:114` | `var(--surface-1)` | Toast background transparent | `--bg-raised` |
| [ ] 2 | `pages/workspace/right-sidebar/attentions-section.tsx:89,167` | `var(--sp-0_25)` | Vertical padding collapses to 0 | `--sp-px` (1px) or `--sp-0_5` |
| [ ] 3 | `pages/source-repos-settings-panel.tsx:161` | `var(--surface-2)` | Hover background no-op | `--bg-hover` |
| [ ] 4 | `components/history-gap-banner.tsx:23` | `var(--fg-muted)` | Text color falls back to inherit | `--fg-3` |
| [ ] 5 | `pages/workspace/conversations/new-chat-draft.tsx:451` | `var(--bg-base)` | Background transparent | `--bg` |
| [ ] 6 | `pages/invite-accept.tsx:132` | `var(--destructive)` | Urgent color not applied | `--state-error` (or `text-destructive` util) |
| [ ] 7 | `pages/agent-detail.tsx:692` | `fontSize: "var(--text-body-size)"` | Font size not applied **+** illegal inline `fontSize` | Use `text-body` class; drop inline `fontSize` |

Also check: a stray `var(--shadow-lg)` reference exists (1×) but `--shadow-lg` is undefined
(only `--shadow-sm` / `--shadow-md` exist). Locate and either define `--shadow-lg` or use `--shadow-md`.

## P0.5 — Close the guardrail hole (highest leverage)

The token linter (`scripts/check-design-tokens.sh`) is line-based, so it missed both classes
of P0 bug. Two additions catch the entire P0 list automatically and stop recurrence:

- [ ] **Undefined-token check:** collect every `var(--x)` in `src/`, diff against the tokens
  defined in `index.css`; fail on any reference to an undefined token. (Would have caught all 7 above.)
- [ ] **Multi-line style detection:** rules 1 (raw px) and 5 (inline font props) only match when
  `style={{` and the property are on the same line. `agent-detail.tsx:692` evaded both by spanning
  lines. Normalize whitespace before matching, or scan JSX style objects as blocks.

## P1 — Redundancy & contradiction (DECISIONS NEEDED before fixing)

- [ ] **Duplicate color vocab.** `--ok` / `--warn` / `--danger` have byte-identical values to
  `--state-idle` / `--state-blocked` / `--state-error`. Two names per color = change-one-forget-other.
  **DECIDED + DONE:** removed `--ok/--warn/--danger`; severity migrated to the feedback set
  `--success` / `--warning` / `--danger` (aliased to `--accent` / `--state-blocked` / `--state-error`).
- [ ] **Triple-identical green.** `--accent` == `--ok` == `--state-idle` == `oklch(0.72 0.17 150)`.
  Brand/primary, "success", and "idle agent" are visually indistinguishable.
  **DECIDED:** `--state-idle` becomes a neutral/de-saturated tone, distinct from `--accent` and from
  `--state-offline`. New value TBD — propose options first.
- [ ] **Two radius systems, both live.** Semantic `--radius-chip/input/panel/dialog` vs shadcn-legacy
  `--radius-sm/md/lg/xl`. `rounded-md` (legacy) is used **38×**; the flagship `Dialog`
  (`dialog.tsx:32`) uses `rounded-lg` + Tailwind `shadow-lg`, bypassing `--radius-dialog` /
  `surface-overlay` / the `--shadow-*` scale. `Badge` uses `rounded-md` while `DenseBadge` uses
  `--radius-chip`. **DECIDED:** standardize on the semantic four; migrate `rounded-md`/`rounded-lg`,
  fix `Dialog`/`Badge`, retire `--radius-sm/md/lg/xl`.
- [ ] **Dead token.** `--text-live` (32px tier) has zero `text-live` usages. Adopt it (it's meant for
  the live-status hero) or delete it.
- [~] **Inconsistent focus treatment.** Button `focus-visible:ring-1 ring-ring`; Badge
  `focus:ring-2 ring-offset-2`; settings-save button `outline: --hairline-bold solid --accent-ring`.
  **Decision:** define one focus recipe (token + utility) and apply everywhere.

## P2 — Omissions

- [ ] **No `--state-*-soft` companions.** Callouts have soft+strong pairs; state colors only have the
  strong tone, so `lib/tones.ts` and `.context-change-breakdown` compute `color-mix(... 12-14%)` /
  hardcode `oklch(.../0.12)` at the call site. Add `--state-idle-soft` … `--state-error-soft`.
- [ ] **`.dark` missing `color-scheme: dark`** (only `.landing-marketing` sets it). Native form
  controls / scrollbars don't get dark UA rendering in app dark mode.
- [ ] **`--color-*` semantic alias layer is unadopted.** `--color-text-*` / `--color-surface-*` /
  `--color-border-*` are each referenced once (only the styleguide). Real components use `--fg`,
  `--bg-raised`, `--border` directly. **DECIDED:** delete the alias layer; `--fg`/`--bg-*`/`--border`
  are canonical. Keep only the shadcn-compat aliases the primitives need (`--color-primary`,
  `--color-destructive`, `--color-ring`, etc.).
- [ ] **Marketing surface contrast gap.** `.landing-marketing` overrides `--bg`/`--fg`/`--border` but
  not the callout soft/strong pairs or `--state-*` — a notice on the near-black marketing canvas
  resolves to light-mode values. Define them in scope or guard against callouts there.
- [ ] **No `info` (blue) callout pair** — only error/warn/success.

## P3 — Discipline

- [ ] **`.context-live-*` is off-palette.** ~40 lines in index.css hardcode blue hues 255–265
  (e.g. `oklch(0.2 0.04 265)`) that exist in no token. Bring them into the token system.
- [ ] **Spacing rhythm.** Half-steps (`--sp-1_25`=5px, `--sp-1_75`=7px) are used 12× / 23×, signalling
  pixel-nudging off a 4/8 rhythm. Converge to 4/8; mark half-steps as explicit exceptions.
- [ ] **Prune dead `--sp-*`.** Defined but unused in components: `--sp-2_75`, `--sp-3_25`, `--sp-3_75`,
  `--sp-4_5`, `--sp-8_5`, `--sp-15`, `--sp-16`, `--sp-20`, `--sp-45`, `--sp-60`, `--sp-80`, `--sp-90`
  (verify against index.css's own usage before removing).

---

## Structural gaps (longer-term, not blocking)

- **No animation token registry** — durations/easings are per-keyframe literals in `index.css`.
- **CLI (`apps/cli`) has no visual system** — plain commander + inquirer text; the design system covers the web surface only.

---

## Notes for whoever picks this up

- P0 + P0.5 are safe to do anytime — pure bugfixes, no design judgment.
- P1 / the `[~]` items need an owner decision; they're the agenda for the optimization discussion.
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
- [x] Selected / active states → neutral fill (`--bg-active` / `--primary`), not green tint.
- [x] De-tinted the neutral ramp to chroma 0 (decision 1), light + dark.
- [x] Guardrail **rule 10** bans the retired `--accent` family to force completeness.
- [x] Updated `/preview/styleguide` swatches (split into Primary / Brand groups); verified light + dark.
- [x] (already done in cleanup) working=blue / blocked=amber / error=red / idle=neutral.

**Phase 1 — primitives (`components/ui/`) — DONE 2026-05-28 (PR ____):**
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
    across pages; needs a by-eye pass.
  - Extend the focus ring to the remaining interactive primitives (`tab-bar`,
    `segmented-control`, `command`, `popover` triggers, `filter-pill`) — they paint no ring
    today, so no visible mismatch, but it's an a11y coverage gap.
  - Button/Badge base `ring-offset-background` uses the page surface; on a raised card/menu
    a sub-perceptible 2px seam can appear on keyboard focus (a primitive can't know its
    parent surface). Masked by the filled fill; acceptable until a per-surface convention exists.
  - Component-grammar restyle (Tabs, ConversationList, ChatView, etc.) is Phase 2.

**Phase 2 — component grammar (workspace):**
- [ ] `ConversationList`: add a Search box; tabs-as-underline; rounded-square avatars; neutral selected row.
- [ ] `ChatView`: neutral "you" bubble; neutral send button; blue working tag.
- [ ] Right **Session sidebar**: agent card + Runtime/Model KV + Live-context tree nodes (green) + Needs-you.

**Phase 3 — rollout + folded cleanup:**
- [ ] Apply across remaining pages (Team roster, Settings, onboarding, …).
- [ ] Add `--state-*-soft` tokens (so `tones.ts` stops computing `color-mix` at call sites).
- [ ] `color-scheme: dark` on `.dark`; bring the off-palette `.context-live-*` blues into tokens.

**Phase 4 — close-out:**
- [ ] QA in light + dark.
- [ ] Update `/preview/styleguide` to render the new language.
- [ ] Rewrite DESIGN.md §3 (Color) / §8 (Iconography) / §10 (Theming) to describe the
  now-implemented language; drop the "migration in progress" caveats.
