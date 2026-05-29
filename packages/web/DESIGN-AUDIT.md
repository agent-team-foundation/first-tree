# Design System Audit & Rollout Plan

> Companion to [DESIGN.md](DESIGN.md). DESIGN.md defines the target visual
> language; this file tracks what has shipped, what remains, and the rollout
> order.

## Scope

This audit covers visual design language and design-system consistency for
`packages/web`: tokens, color semantics, typography, spacing, radius, surfaces,
elevation, focus states, icons, motion, component grammar, styleguide, and
light/dark QA.

This audit does **not** define product functionality, data models, API schemas,
workflow logic, GTM positioning, or information architecture.

## Target Direction

The adopted direction is:

- near-monochrome, content-first UI
- neutral primary actions and selected states
- green reserved for brand, Context Tree surfaces, and success semantics
- sparse semantic color for working / blocked / error / idle / offline states
- quiet operational craft: low noise, precise spacing, hairline borders, soft
  elevation, thin line icons, rounded-square avatars, and restrained right-side
  detail panels
- token-only implementation: raw color, spacing, size, typography, and shadow
  values stay centralized in `src/index.css`

## Completed

### Foundation

- Neutral primary role introduced for actions, selected states, send buttons,
  links, and focus affordances.
- Brand green renamed to `--brand` and reserved for logo, Context Tree surfaces,
  brand moments, and success semantics.
- Old `--accent` usage was reclassified and removed from component usage.
- Neutral gray ramp de-tinted to pure neutral.
- `--state-idle` moved from green to cool neutral, separating idle from brand
  and success.
- Feedback set standardized around `--success`, `--warning`, and `--danger`.

### Guardrails

- Ghost token references were fixed.
- Undefined-token lint check was added to catch invalid `var(--token)` usage.
- Guardrail bans retired `--accent` token family.

### Radius / Elevation / Primitives

- Radius scale consolidated to semantic tokens:
  `--radius-chip`, `--radius-input`, `--radius-panel`, `--radius-dialog`.
- Legacy radius tokens were removed.
- Dialog shadow moved from undefined / oversized shadow usage to the shared
  `--shadow-md` tier.
- Button default variant now uses neutral primary.
- Button, Badge, Input, Dialog close, Toast, and SettingsField share the core
  accessible focus-ring recipe.
- Primitive shadows were flattened / tokenized for the quieter operational look.

### Cleanup

- Unused `--color-text-*`, `--color-surface-*`, and `--color-border-*` alias
  layer was removed.
- Styleguide swatches were updated for Primary / Brand / Feedback separation.
- DESIGN.md was updated to remove external product references and describe the
  visual language directly.

## Remaining TODO

### Guardrails

- Add multi-line inline-style detection to `scripts/check-design-tokens.sh`.
  Current line-based rules can miss raw px or inline font props split across
  multiple lines.

### Tokens

- Decide whether to adopt or remove `--text-live`.
- Add `--state-*-soft` companion tokens so state-tinted surfaces stop computing
  ad hoc `color-mix(...)` at call sites.
- Add an `info` callout pair for blue informational notices.
- Add `color-scheme: dark` to `.dark`.
- Fix marketing-surface contrast for callout and state tokens.
- Bring `.context-live-*` colors into the token system.
- Review spacing rhythm and reduce half-step pixel nudging where it is not
  intentional.
- Prune unused `--sp-*` tokens after verifying they are not used by CSS-only
  selectors or the styleguide.

### Components

- Extend the shared focus-ring recipe to remaining interactive primitives:
  `tab-bar`, `segmented-control`, `command`, `popover` triggers, and
  `filter-pill`.
- Replace remaining text glyphs such as check / warning / error / gear symbols
  with `lucide-react` icons where icons are needed.
- Review ring-offset behavior for controls mounted on raised surfaces and
  define a consistent per-surface convention if needed.

### Workspace Visual Grammar

- `ConversationList`: add / align search, underline tabs, rounded-square
  avatars, and neutral selected-row treatment.
- `ChatView`: align user bubble, send button, and working tag with neutral
  primary + blue working semantics.
- Right details panel: align section hierarchy, neutral panel surfaces, green
  Context Tree signals, and amber/red attention states with the shared visual
  language.

### Rollout / QA

- Apply the visual language across Team roster, Settings, Onboarding, and other
  remaining pages.
- Update `/preview/styleguide` as implementation catches up.
- Run light and dark visual QA for the dashboard.
- Remove migration caveats from DESIGN.md once implementation fully matches the
  target language.

## Rollout Plan

### Phase 0 — Foundation (done)

- Establish neutral primary.
- Reserve green for brand / Context Tree / success.
- De-tint neutral ramp.
- Separate idle from success.
- Fix ghost tokens and undefined-token guardrail.

### Phase 1 — Primitive Baseline (done)

- Normalize Button, Badge, Input, Card, Dialog, Toast, RowActionsMenu, and
  SettingsField around shared radius, shadow, and focus conventions.
- Remove legacy radius and unused alias layers.

### Phase 2 — Guardrails And Token Cleanup (next)

- Add multi-line inline-style lint detection.
- Resolve `--text-live`.
- Add `--state-*-soft` and `info` callout tokens.
- Add `.dark { color-scheme: dark; }`.
- Tokenize `.context-live-*` colors.
- Start spacing and dead-token cleanup.

### Phase 3 — Component Grammar

- Finish focus-ring coverage for remaining interactive primitives.
- Replace non-lucide glyph usage.
- Align Workspace visual grammar:
  ConversationList, ChatView, and right details panel.

### Phase 4 — Surface Rollout

- Apply the unified visual language to Team, Settings, Onboarding, and other
  remaining pages.
- Keep changes visual-only unless a separate product brief explicitly expands
  scope.

### Phase 5 — Closeout

- Update `/preview/styleguide`.
- Run light/dark visual QA.
- Re-run typecheck / token lint.
- Remove any migration caveats from DESIGN.md that no longer apply.

## Verification

After visual-system changes:

```bash
pnpm --filter @first-tree/web lint:tokens
pnpm --filter @first-tree/web typecheck
```

For broader rollout changes, also run the relevant web tests or visual
regression checks before marking a phase complete.
