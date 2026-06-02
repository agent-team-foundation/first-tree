# Onboarding UI — DESIGN.md Compliance Audit

> **Stage:** audited **and implemented** on `audit/onboarding-ui` (typecheck + `lint:tokens`
> + full test suite green; light/dark verified in `/preview/onboarding`). See
> **§5 Implementation status** for exactly what shipped vs what was deliberately deferred.
> **Date:** 2026-06-01
> **Branch:** `audit/onboarding-ui` (off `origin/main` @ `1f76bf9`)
> **Spec:** [DESIGN.md](../DESIGN.md) + the enforced linter [`scripts/check-design-tokens.sh`](../scripts/check-design-tokens.sh)
> **Companion:** [DESIGN-AUDIT.md](DESIGN-AUDIT.md) (system-wide status; its Phase 3 already lists
> "Apply across remaining pages (Team roster, Settings, **onboarding**, …)" as **open** — this doc is that onboarding pass.)

---

## 0. Scope & method

Reviewed every onboarding UI surface — read source line-by-line and cross-checked the DEV
gallery at `/preview/onboarding`:

| Surface | File |
|---|---|
| Shell (top bar + two-column layout) | `src/pages/onboarding/onboarding-shell.tsx` |
| Progress rail | `src/pages/onboarding/progress-rail.tsx` |
| Shared flow widgets (heading, note, working, status, command box, repo picker) | `src/pages/onboarding/flow-ui.tsx` |
| Progressive-disclosure guides | `src/pages/onboarding/guides.tsx` |
| Step: welcome (invitee) | `src/pages/onboarding/steps/step-welcome.tsx` |
| Step: team (admin) | `src/pages/onboarding/steps/step-team.tsx` |
| Step: connect-code (admin) | `src/pages/onboarding/steps/step-connect-code.tsx` |
| Step: connect-computer | `src/pages/onboarding/steps/step-connect-computer.tsx` |
| Step: create-agent | `src/pages/onboarding/steps/step-create-agent.tsx` |
| Step: kickoff (admin + invitee sub-states) | `src/pages/onboarding/steps/step-kickoff.tsx` |
| Connect "stuck?" recovery panel (shared w/ Settings) | `src/components/connect-stuck-panel.tsx` |
| Pre-login invite-accept page | `src/pages/invite-accept.tsx` |
| Routing only (no UI gap) | `onboarding-page.tsx`, `onboarding-flow.tsx`, `steps.ts`, `copy.ts` |

**Linter caveat established by reading the script.** `check-design-tokens.sh` is **line-based
`grep`**. Two whole classes of violation slip past it and are therefore present in committed,
"green" code:

1. **Numeric px** — rule 1 matches only the literal string `Npx`. A JS style number like
   `minHeight: 38` becomes `38px` at runtime but never matches, so it passes.
2. **Multi-line `style={{ … }}` objects** — rules 1 & 5 use `style=\{[^}]*…` which stops at the
   first line. An inline `fontWeight`/`lineHeight` on its own line inside a multi-line style
   object evades detection (DESIGN-AUDIT P0.5 notes this hole is still open).

So "passes `lint:tokens`" ≠ "complies with DESIGN.md". Several findings below are real spec
violations that the gate does not catch.

---

## 1. Executive summary

The onboarding flow is **mostly token-clean** — colors, spacing, and the 6-tier type scale are
referenced through tokens almost everywhere, and the shell/rail layout is disciplined. The gaps
are **not** raw hex/px-string leaks; they are **structural divergence from the design system's
component layer and a few linter-blind literals.**

**The single biggest theme:** the **pre-login `invite-accept.tsx` page is the gold standard** —
it composes `Card`, `Button`, the `focus-visible` ring recipe, and Tailwind utility classes. The
**in-flow wizard steps do the opposite** — they hand-roll text inputs, checkboxes, chips,
notices, command boxes, and quiet link-buttons with inline `style={{…}}` + `color-mix(…)`,
re-implementing primitives that already exist in `src/components/ui/`. Bringing the wizard up to
the invite-accept bar is ~80% of the work.

**Severity tally:** 3 medium-high · 5 medium · 5 low · 2 nit.

| # | Finding | Primary clause | Severity | Effort |
|---|---|---|---|---|
| F1 | Text inputs bypass the `Input` primitive; one has **no visible focus state** | §7, §13 | **Med-High** | S |
| F2 | Quiet/secondary actions hand-rolled as raw `<button>` instead of `Button` `link`/`ghost`; use the **disabled `--fg-4` tier** for live text | §7, §4, §13 | **Med-High** | S–M |
| F3 | Notices (`FlowNote`) hand-roll callout colors instead of the `--color-{error,info}` / `-soft` pairs | §3 | **Med-High** | S |
| F4 | Duplicated bespoke widgets (command box ×2, checkbox row ×2) instead of one shared component | §7 | Med | M |
| F5 | Numeric px literals (`38`, `8`, `-3`) evade the linter | §5, rule 1 | Med | S |
| F6 | `borderRadius: 999 / "50%"` — hardcoded radius (no full-round token exists) | §5, rule 8 | Med | S |
| F7 | Inline `fontWeight` / `lineHeight` (multi-line) evade the linter | §4, rule 5 | Med | S |
| F8 | Hand-rolled surfaces via `color-mix(--bg-* NN%)` instead of `.surface-*` utilities | §6 | Low | M |
| F9 | Non-lucide glyphs: literal `✓` and `→` in text | §8 | Low | S |
| F10 | Informational "stuck?" panel wears card chrome (bordered/filled) | §language pillar 5 | Low | S |
| F11 | Selection tint is `--primary` 8% vs OptionCard's ~5% spec; checkbox rows aren't the primitive | §7 | Low | M |
| F12 | `text-muted-foreground` (shadcn alias) in new code instead of short semantic names | §3 | Nit | S |
| F13 | Dead CSS classes `.onboarding-runtime-option`, `.onboarding-name-input` in `index.css` | §1 | Nit | S |

(Effort: S ≈ <1h, M ≈ 1–3h per area. All additive/visual; none touches flow logic.)

---

## 2. Detailed findings

### F1 — Text inputs bypass the `Input` primitive (and the §13 focus rule) — **Med-High**

A first-class `Input` primitive exists (`src/components/ui/input.tsx`) and already implements the
DESIGN.md §13 focus recipe for bordered controls: `focus-visible:border-ring` (deepen own border,
no offset ring). Three onboarding inputs re-implement a raw `<input>` instead, with lower fidelity:

- `steps/step-team.tsx:83-107` — raw input; focus handled by **imperative JS** `onFocus`/`onBlur`
  setting `borderColor = "var(--primary)"`. Wrong token (`--primary`, not `--ring`) and an
  anti-pattern (DOM mutation instead of `:focus-visible` CSS).
- `steps/step-create-agent.tsx:90-112` — identical raw-input + JS-focus pattern.
- `steps/step-kickoff.tsx:228-242` — raw input with `outline: "none"` **and no focus handler at
  all** → **the tree-URL field has no visible focus indicator.** This is an outright §13 /
  WCAG focus-visibility regression, not just a consistency nit.

**Violates:** §7 (use the primitive inventory), §13 ("Focus is visible but restrained … anything
with its own border darkens that border to `--ring` on focus").
**Fix:** replace all three with `<Input … />`; delete the JS focus handlers. The mono tree-URL
field can keep `className="mono"` on the primitive.
**Impact:** correctness (focus a11y) + consistency. **Effort:** S.

---

### F2 — Quiet/secondary actions hand-rolled instead of `Button` variants — **Med-High**

The `Button` primitive ships `variant="link"` (`text-primary underline-offset-4 hover:underline`)
and `variant="ghost"`, both with the §13 borderless focus ring. The flow instead scatters raw
`<button>` elements styled inline, and most use **`color: var(--fg-4)`** — which §4 defines as the
**disabled** foreground tier — for *live, clickable* text. That's both off-system and a contrast/
affordance concern (an interactive control rendered at the disabled tier).

Locations:
- `onboarding-shell.tsx:43-61` ("Finish later") and `:63-70` ("Sign out") — raw buttons, `--fg-4`.
- `steps/step-connect-code.tsx:138-153` ("Skip for now") and `:173-186` ("Cancel") — raw, `--fg-4`.
- `steps/step-kickoff.tsx` — `LINK_STYLE` const (`:27-33`, ink `--primary`) on the "Create
  instead" / "I already have one" buttons (`:249-259`, `:263-270`); plus
  "Continue without a project" raw buttons at `:494-501` and `:588-595` (ink `--fg-4`).

**Violates:** §7 (Button variants exist), §4 (`--fg-4` is the disabled tier), §13 (focus ring).
**Fix:** `<Button variant="link">` for the inline text links; `<Button variant="ghost" size="sm">`
where a quiet button affordance is wanted. Drop the `--fg-4`/`LINK_STYLE` inline styling. Pick a
single convention for "tertiary action" across the flow.
**Impact:** consistency + a11y contrast. **Effort:** S–M (≈8 call sites, mechanical).

---

### F3 — Notices hand-roll callout colors instead of the §3 callout token pairs — **Med-High**

`flow-ui.tsx` `FlowNote` (`:28-53`) is the flow's only inline-notice component and is used
~20× across the steps. DESIGN.md §3 "Inline callouts (notices)" exists precisely so notices
*don't* hand-mix colors: `--color-error`/`--color-error-soft`, `--color-info`/`--color-info-soft`
(blue, hue 245), etc. `FlowNote` instead:

- **error tone:** ink `--state-error`, border hand-rolled `color-mix(… var(--state-error) 28% …)`,
  bg `--state-error-soft`. The `--state-*` family is for **agent status dots/chips**, not notices;
  §3 says reach for the `--color-error` callout pair here.
- **info tone:** ink `--fg-2` + bg `color-mix(… var(--primary) 8% …)` — a *neutral* wash, ignoring
  the dedicated blue **`--color-info` / `--color-info-soft`** pair the system added for static
  informational notices.

§3 also explicitly says: "Use these [`-soft` companions] for state-tinted surfaces … **instead of
hand-rolling `color-mix(... var(--state-*) ..., transparent)` at the call site.**" `FlowNote`'s
border is exactly that hand-roll.

**Violates:** §3 (Inline callouts; soft-companion guidance).
**Fix:** re-point `FlowNote` to the callout pairs — `error → --color-error` (ink/border) +
`--color-error-soft` (bg); `info → --color-info` + `--color-info-soft`. If a `-line` (border-tone)
token is still missing for the border, add one to `index.css` rather than hand-mixing (DESIGN-AUDIT
already flags `--state-*-line` as a wanted follow-up).
**Impact:** correctness (info notices should read as the system's blue, not neutral) + theming
single-source. **Effort:** S (one component; all call sites inherit).

---

### F4 — Duplicated bespoke widgets instead of one shared component — **Med**

Two widgets are implemented twice, nearly identically:

- **Copyable command/URL box.** `flow-ui.tsx` `CommandBox` (`:140-209`) and the share-URL box in
  `step-kickoff.tsx` `InviteeNoInstallation` (`:663-705`) are the same monospace-box + Copy-button
  pattern, reimplemented inline in the second site (same `minHeight: 38`, same surface mix, same
  copy-state logic).
- **Selectable checkbox row.** `flow-ui.tsx` `RepoPicker`'s row (`:261-315`) and
  `step-kickoff.tsx` `InviteeConfirm`'s row (`:450-481`) are the same sr-only-checkbox + surrogate-
  box + tinted-active-row markup, duplicated.

**Violates:** §7 (the system is a bespoke primitive library; this is the place to add primitives,
not re-inline them).
**Fix:** extract a `CopyableField`/`CommandBox` (already exists — just reuse it for the share-URL)
and a shared `CheckRow` (or a real `Checkbox` primitive in `components/ui/`). `FlowChip` in
`guides.tsx:153-169` is likewise a chip that could be the existing `Badge`/`StateChip`.
**Impact:** maintainability + visual consistency. **Effort:** M.

---

### F5 — Numeric px literals evade the linter — **Med**

Raw JS-number sizes (→ px at runtime) that DESIGN.md §5 forbids ("never write `1px`" / never
hardcode sizes), invisible to rule 1:

- `flow-ui.tsx`: `minHeight: 38` (`:159`, `:195`); `width: 8, height: 8` (`:106`); `inset: -3` (`:111`).
- `step-kickoff.tsx`: `minHeight: 38` (`:669`, `:693`).

**Violates:** §5 / enforcement rule 1 (in spirit; the regex misses numerics).
**Fix:** map to the `--sp-*` ladder (`8 → var(--sp-2)`; `38` ≈ control height — use `--sp-9`/`--sp-10`
or a shared control-height token). The 3px ring offset → `--sp-0_75`.
**Impact:** discipline + closes a linter blind spot. **Effort:** S. *(Worth a follow-up to
normalize whitespace / scan numeric values in the linter — DESIGN-AUDIT P0.5.)*

---

### F6 — Hardcoded full-round radius — **Med**

`borderRadius: 999` (`progress-rail.tsx:47`; `guides.tsx:42`, `:65`) and `borderRadius: "50%"`
(`flow-ui.tsx:73`, `:107`) hardcode a pill/circle radius. §5 defines exactly four radius tokens
(`chip/input/panel/dialog`) and "never hardcode … radius" — but **there is no full-round token**,
so today there's no compliant way to make a circle.

**Violates:** §5 (radius is token-only).
**Fix:** add a `--radius-full` (or `--radius-pill`) token to `index.css` and reference it; this is
the §14 "need a value the tokens don't cover? add a token" path. Then sweep the five sites.
**Impact:** closes a genuine gap in the token set (circular avatars/dots/discs recur elsewhere too).
**Effort:** S.

---

### F7 — Inline typography props (multi-line) evade the linter — **Med**

- `progress-rail.tsx:108` — inline `fontWeight: state === "active" ? 600 : 400` inside a multi-line
  style object (rule 5 misses it).
- `flow-ui.tsx:166` — inline `lineHeight: 1.65` in `CommandBox`.

**Violates:** §4 / enforcement rule 5 (typography must come from `text-*` tiers + `font-*` classes).
**Fix:** rail → `font-normal` / `font-semibold` classes (the rail already uses `text-label`); the
command box → drop inline `lineHeight`, rely on the `mono`/`text-label` tier (add a `--leading-*`
token if a looser line-height is genuinely needed).
**Impact:** discipline + linter blind spot. **Effort:** S.

---

### F8 — Hand-rolled surfaces instead of `.surface-*` utilities — **Low**

§6 ships `.surface-raised` / `.surface-sunken` / `.surface-overlay` to "consolidate the
background+border+radius+shadow combos (prefer these over hand-rolling)". Several spots hand-mix a
surface instead:

- `flow-ui.tsx` `CommandBox` (`:161-163`): `color-mix(… var(--bg-sunken) 42% …)` + hand-rolled border.
- `connect-stuck-panel.tsx:29-30`, `guides.tsx:85-88` (TerminalGuide), `:184-185` (InstallGuide):
  `color-mix(… var(--bg-raised) 40% …)` + faint border.

**Violates:** §6 (prefer the surface utilities).
**Fix:** use `.surface-sunken`/`.surface-raised` where the mix matches; if the partial-opacity
washes are intentional, define them as `--surface-*` tokens rather than per-call-site mixes.
**Impact:** consistency / single-source. **Effort:** M (need an eye on each to confirm the wash is
equivalent).

---

### F9 — Non-lucide glyphs — **Low**

§8: "lucide-react only — single icon set, no custom glyphs". Found:

- `guides.tsx:126` — literal `✓ macbook-pro connected` (inside the mock-terminal illustration).
- `connect-stuck-panel.tsx:50` and `guides.tsx` node link — trailing `→` text arrow.

**Violates:** §8 (this is the long-deferred "✓ ⚠ ✗ → lucide purge" — see DESIGN-AUDIT Phase-1
follow-up).
**Fix:** lucide `Check` / `ArrowRight`. The terminal `✓` is borderline (it's faux terminal output
inside a `role="img"`), so it's the lowest priority of the set — call it out and decide.
**Impact:** cosmetic/consistency. **Effort:** S.

---

### F10 — Informational panel wears card chrome — **Low**

DESIGN.md design-language pillar 5: "Card chrome = interactivity. Read-only / informational states
(status readouts, confirmations) render as plain labeled content, **not** wrapped in a filled/
bordered card." `connect-stuck-panel.tsx` is pure informational recovery tips (a title, a bulleted
list, one link) but is wrapped in a bordered + `bg-raised` filled card (`:23-31`).

**Violates:** language pillar 5.
**Fix:** render as plain content, or — since it's a "heads-up, here's why it might be stuck" notice
— route it through the `info` `FlowNote`/callout (which F3 is already fixing) rather than a generic
card. (The `TerminalGuide`/`InstallGuide` boxes are genuine *illustrations*, so their chrome is
defensible.)
**Impact:** subtle hierarchy. **Effort:** S. *(Note: shared with Settings → Computers, so confirm
both surfaces.)*

---

### F11 — Selection tint / checkbox rows off the OptionCard spec — **Low**

`step-create-agent.tsx` correctly uses the `OptionCard` primitive for Visibility. But the repo/
project selection rows (`flow-ui.tsx` `RepoPicker:276`, `step-kickoff.tsx` `InviteeConfirm:458`)
hand-roll a checkbox row with an active tint of `--primary` **8%**. §7's selection spec calls for a
"**very light `--fg` tint (~5%)**". These are multi-select checkboxes (not radio OptionCards), so
§7's exact rule doesn't bind — but the divergent tint % and the lack of a shared primitive are
worth aligning (ties into F4).

**Violates:** §7 (selection-state convention; primitive reuse).
**Fix:** introduce a `Checkbox`/`CheckRow` primitive matching OptionCard's tint discipline; reuse
in both pickers.
**Impact:** minor visual consistency. **Effort:** M (folds into F4).

---

### F12 — shadcn alias used in new code — **Nit**

`step-create-agent.tsx:131` (`text-muted-foreground`) and several spots in `invite-accept.tsx`.
§3: the shadcn-compat aliases are "preserved so shadcn-shaped components keep working — **prefer the
short semantic names above in new code**." Onboarding is new code.
**Fix:** `text-muted-foreground → text-[color:var(--fg-3)]` (or a `text-fg-3` utility if defined).
**Impact:** nit / single-source hygiene. **Effort:** S.

---

### F13 — Dead onboarding CSS in `index.css` — **Nit**

`.onboarding-runtime-option` (`index.css:1423-1432`) and `.onboarding-name-input::placeholder`
(`:1434-1437`) have **zero references** in `src/` (verified by grep). Leftover from an earlier
runtime-picker / named-input design.
**Fix:** delete (or re-wire if the runtime picker is meant to return). Housekeeping toward §1
single-source.
**Impact:** none visual; removes confusion. **Effort:** S.

---

## 3. What's already compliant (no action)

So the plan stays honest about scope — these were checked and pass:

- **Color is token-driven and semantically correct.** `cta` (green hero) is used on exactly the
  creation/launch moments (`step-create-agent` "Create …", admin/invitee kickoff "Start"); every
  other advance is neutral `default` — matching language pillar 2 (no green-on-dense-actions).
- **Working/status affordances** use `--state-working` (pulsing dots) and `--success` (✓ row)
  correctly per the green-liveness model (§3).
- **Type scale**: all copy uses the 6-tier `text-eyebrow…text-title` utilities; no Tailwind default
  text sizes.
- **Spacing**: `--sp-*` ladder / Tailwind utilities throughout (the few literals are F5).
- **Shell & rail layout**: disciplined, borderless, token-driven; reduced-motion fallbacks present
  for every animation (§9).
- **`invite-accept.tsx`** is the reference implementation — `Card`/`Button`/utility classes/§13
  focus ring. Only nits (F12) and one debatable warning-callout color (the "you'll switch teams"
  note at `:165-174` uses a neutral `--bg-sunken` panel; §3 would suggest the `--color-warn` pair —
  flagging as a **judgment call**, not a hard gap).

---

## 4. Proposed remediation phasing (for discussion — not yet started)

Grouped to minimize churn and let each land green:

- **Phase A — primitive adoption (highest UX value):** F1 (`Input`), F2 (`Button` link/ghost),
  F3 (callout tokens). Mechanical, removes the focus-a11y regression, biggest consistency win.
- **Phase B — token gaps + linter blind spots:** F5 (numeric px → `--sp-*`), F6 (`--radius-full`
  token), F7 (inline font props). Optionally tighten the linter to catch numerics + multi-line
  styles so these can't regress.
- **Phase C — dedupe + surfaces:** F4 (shared CommandBox/CheckRow), F8 (`.surface-*`), F11.
- **Phase D — cosmetic/housekeeping:** F9 (lucide glyphs), F10 (stuck-panel chrome), F12, F13.

**Two open judgment calls to confirm with the user before implementing:**
1. The "you'll switch teams" note and the "stuck?" panel — should informational notices be the
   blue `info` callout, a neutral panel, or plain content? (F3/F10 hinge on this.)
2. The mock-terminal `✓` (F9) — purge to lucide, or accept as faux-output inside a `role="img"`?

**Acceptance for the eventual implementation:** `pnpm --filter @first-tree/web typecheck`
(tsc + `lint:tokens`) green, plus a by-eye pass of every state in `/preview/onboarding` (light +
dark), since the most impactful fixes (focus, callout color) are exactly the kind the linter can't
see.

---

## 5. Implementation status (2026-06-01)

Implemented under full autonomy (user opted out of the plan-approval checkpoint). Verified:
`tsc` + `lint:tokens` green, full monorepo test suite green (web 516 / client 1020 / cli 382 /
server 1275), and every state eyeballed in `/preview/onboarding` in light **and** dark.

**Shipped:**

| # | What changed |
|---|---|
| F1 | All three raw `<input>`s (`step-team`, `step-create-agent`, `step-kickoff` tree-URL) → the `Input` primitive. Fixes the tree-URL field's missing focus state; focus now follows §13 (`focus-visible:border-ring`). |
| F2 | Quiet/secondary actions (`Sign out`, `Finish later`, `Skip`, `Cancel`, `Create instead`, `I already have one`, `Continue without a project` ×2) → `<Button variant="link">`. No more `--fg-4` (disabled tier) on live text; all get the §13 focus ring. |
| F3 | `FlowNote` → the §3 callout token pairs (`border-error bg-error-soft text-error` / `border-info bg-info-soft text-info`), same grammar as `doc-preview-drawer`. Info notices now read as the system's blue instead of neutral. |
| F4 | New shared `SelectableRow` (used by `RepoPicker` + invitee confirm list); the invitee share-URL box now reuses `CommandBox`. ~145 net lines removed. |
| F5 | Numeric px (`38`, `8`, `-3`) → `--sp-*` ladder. |
| F6 | Added `--radius-full` token; all `borderRadius: 999 / "50%"` → `var(--radius-full)`. |
| F7 | Inline `fontWeight` (progress-rail) → `font-semibold/normal` classes; dropped inline `lineHeight` (CommandBox). |
| F9 | Mock-terminal `✓` → lucide `Check` (+ `--success` green); stuck-panel `→` → lucide `ArrowRight`. |
| F11 | Selection tint `--primary` 8% → `--fg` ~5% (matches the OptionCard §7 convention), folded into `SelectableRow`. |
| F13 | Removed dead `.onboarding-runtime-option` / `.onboarding-name-input` CSS. |

**Deliberately deferred (with rationale):**

- **F8 (surface washes).** `CommandBox` / guides / stuck-panel use `color-mix(--bg-* NN%,
  transparent)` rather than `.surface-*`. These already reference tokens (not raw values), §6 is a
  *prefer* guideline not a hard rule, and the partial-opacity wash is a deliberate "quieter than a
  full card" treatment. Forcing `.surface-*` adds full card chrome and risks a visual regression —
  not worth it in a token-compliance pass.
- **F10 (stuck-panel card chrome).** Left as a grouped notice; converting it touches the shared
  Settings → Computers surface and is a visual judgment better made with that surface in view.
- **F12 (`text-muted-foreground` in `step-create-agent`).** Left to stay byte-consistent with the
  sibling New-Agent dialog's Visibility block; a `text-muted-foreground → text-fg-3` sweep should be
  a separate, app-wide change, not a one-off divergence here.
- **Progress-rail back-nav `<button>`.** Kept as a structural rail control (uses `--fg-2`, an
  acceptable tier — not the disabled tier); styling it as a link would read oddly in the rail.
