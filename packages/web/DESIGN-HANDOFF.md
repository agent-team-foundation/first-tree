# Claude Code Handoff - Web Design System Rollout

This handoff is for a Claude Code session that will plan and land the remaining
visual design-system work for `packages/web`.

## Current PR Context

- Branch: `feat/web-design-system-rollout`
- Base documentation commit: `304100cf docs: update web design system rollout`
- PR: created by the user from this branch
- Current committed scope: documentation only
  - `packages/web/DESIGN.md`
  - `packages/web/DESIGN-AUDIT.md`
  - `packages/web/DESIGN-HANDOFF.md`

If the branch has moved, inspect `git status`, `git log --oneline -5`, and the
PR discussion before making changes.

## Suggested Claude Code Prompt

Use this as the opening instruction for the Claude Code session:

```text
Please continue the Web visual design-system rollout in
/Users/gandy/.codex/worktrees/31bc/first-tree-hub.

Important scope:
- This work is strictly visual design language / design-system consistency.
- Do not introduce product functionality.
- Do not change data models, APIs, routing logic, approval flows, or information architecture.
- Do not change GTM positioning or landing-page messaging strategy.

Start by reading:
1. AGENTS.md
2. packages/web/DESIGN.md
3. packages/web/DESIGN-AUDIT.md
4. packages/web/DESIGN-HANDOFF.md
5. packages/web/src/index.css
6. packages/web/scripts/check-design-tokens.sh
7. packages/web/src/pages/styleguide-preview.tsx

Then create your own implementation plan for the remaining rollout. Begin with
the PR 1 scope from DESIGN-HANDOFF.md: guardrails + low-risk tokens.

Keep PRs small and serial:
1. Guardrails + Low-Risk Tokens
2. Token Cleanup + State Surface Migration
3a. Primitive Focus + Icons
3b. Workspace Visual Grammar
4. Surface Rollout + Closeout

Run the relevant verification before marking work complete:
pnpm --filter @first-tree/web lint:tokens
pnpm --filter @first-tree/web typecheck
```

## Current Scope

The work is strictly about visual design language and design-system
consistency:

- tokens
- semantic color
- typography
- spacing
- radius
- surfaces and elevation
- focus states
- icon consistency
- motion vocabulary
- component visual grammar
- styleguide and light/dark QA

Do **not** expand this into product functionality, information architecture,
data models, API schemas, routing logic, approval flows, GTM positioning, or
landing-page messaging strategy.

## Source Documents

- `packages/web/DESIGN.md` is the target design-system spec.
- `packages/web/DESIGN-AUDIT.md` is the rollout plan and current TODO list.
- `packages/web/src/index.css` is the raw token source of truth.
- `packages/web/scripts/check-design-tokens.sh` enforces token discipline.
- `packages/web/src/pages/styleguide-preview.tsx` is the living visual
  reference at `/preview/styleguide`.

## Committed Documentation Changes

The current branch already modified:

- `packages/web/DESIGN.md`
- `packages/web/DESIGN-AUDIT.md`
- `packages/web/DESIGN-HANDOFF.md`

The changes are documentation-only:

- removed external product references from the visual language
- reframed pillar 4 as `Quiet operational craft`
- kept the work scoped to visual design language
- cleaned `DESIGN-AUDIT.md` into a concise rollout plan
- removed product-experience / work-loop / surface-audit material that was
  outside the user's intended scope

Before starting implementation, inspect `git status` and review the PR. Do not
overwrite unrelated user changes.

## Target Visual Direction

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

## Already Done

Foundation:

- neutral primary introduced
- brand green renamed to `--brand`
- old `--accent` usage reclassified and removed from component usage
- neutral ramp de-tinted
- `--state-idle` moved from green to cool neutral
- feedback set standardized around `--success`, `--warning`, `--danger`

Guardrails:

- ghost token references fixed
- undefined-token lint check added
- retired `--accent` family banned

Primitives:

- radius scale consolidated:
  `--radius-chip`, `--radius-input`, `--radius-panel`, `--radius-dialog`
- legacy radius tokens removed
- dialog shadow moved to `--shadow-md`
- button default uses neutral primary
- Button, Badge, Input, Dialog close, Toast, and SettingsField share the core
  focus-ring recipe
- primitive shadows flattened / tokenized

Cleanup:

- unused `--color-text-*`, `--color-surface-*`, `--color-border-*` alias layer
  removed
- styleguide swatches updated for Primary / Brand / Feedback separation
- `DESIGN.md` updated to describe the visual language directly

## Recommended PR Split

Use serial merge order. Design review and exploration can happen in parallel,
but code should merge in this order to avoid token and call-site conflicts.

### PR 1 — Guardrails + Low-Risk Tokens

Goal: make future visual cleanup safer.

Suggested scope:

- add multi-line inline-style detection to `check-design-tokens.sh`
- decide and apply `--text-live` adopt/remove
- add `.dark { color-scheme: dark; }`
- add `info` callout pair
- define `--state-*-soft` tokens
- migrate only obvious low-risk call sites, if any

Expected verification:

```bash
pnpm --filter @first-tree/web lint:tokens
pnpm --filter @first-tree/web typecheck
```

Human decisions:

- `--text-live`: keep only if there is a real dashboard usage; otherwise remove.
- `info` callout: keep it for static informational notices, not dynamic
  working state.

### PR 2 — Token Cleanup + State Surface Migration

Goal: remove ad hoc state colors and off-palette surfaces.

Suggested scope:

- migrate `color-mix(... var(--state-*), transparent)` style surfaces to
  `--state-*-soft`
- tokenize `.context-live-*` colors
- fix marketing-surface contrast for callout and state tokens
- begin spacing rhythm cleanup where changes are obviously value-preserving
- prune unused `--sp-*` only after verifying no CSS-only selectors or
  styleguide usage depend on them

Human decisions:

- `.context-live-*`: decide whether it belongs to existing state / info tokens
  or needs a small local token family.
- spacing half-steps: do not remove all 5px / 7px values blindly; some may be
  intentional optical alignment.

### PR 3a — Primitive Focus + Icons

Goal: finish shared primitive visual grammar before page-level rollout.

Suggested scope:

- extend focus-ring coverage to:
  `tab-bar`, `segmented-control`, `command`, `popover` triggers,
  `filter-pill`
- replace remaining text glyphs such as check / warning / error / gear symbols
  with `lucide-react` icons where icons are needed
- review ring-offset behavior on raised surfaces and define the minimal
  convention needed to avoid visible seams

This PR is separated from Workspace work because it is lower risk and easier
to review.

### PR 3b — Workspace Visual Grammar

Goal: align the high-traffic Workspace surface visually without changing
product function.

Suggested scope:

- `ConversationList`: search alignment, underline tabs, rounded-square avatar
  treatment, neutral selected-row treatment
- `ChatView`: neutral user bubble, neutral send button, blue working tag
- right details panel: section hierarchy, neutral panel surfaces, green Context
  Tree signals, amber/red attention states

Important boundary:

- Do not introduce new product concepts, data models, or navigation structure.
- This is visual grammar only.
- Use screenshots / by-eye review before merging.

### PR 4 — Surface Rollout + Closeout

Goal: apply the visual language across remaining pages and close the audit.

Suggested scope:

- Team roster
- Settings
- Onboarding
- other remaining pages with obvious visual drift
- update `/preview/styleguide`
- run light/dark QA
- remove stale migration caveats from `DESIGN.md` if implementation now matches
  the target language

Expected verification:

```bash
pnpm --filter @first-tree/web lint:tokens
pnpm --filter @first-tree/web typecheck
```

Also run relevant web tests or visual regression checks for touched surfaces.

## Execution Guidance

- Prefer small, reviewable PRs.
- Do not mix product copy / GTM changes into visual cleanup PRs.
- Do not change data contracts or API calls as part of this work.
- Add tokens to `src/index.css` before using new visual values.
- Keep component code referencing semantic tokens, not raw appearance values.
- Use `apply_patch` for manual edits.
- Run `pnpm --filter @first-tree/web lint:tokens` after token or component
  changes.
- Run `pnpm --filter @first-tree/web typecheck` before marking a PR ready.
- For visual changes beyond primitives, capture light/dark screenshots or use
  the existing visual regression flow when practical.

## Suggested Starting Point

Start with PR 1:

1. Inspect `scripts/check-design-tokens.sh`.
2. Add multi-line inline-style detection.
3. Run the token lint.
4. Fix any surfaced violations that are clearly in scope.
5. Decide `--text-live` based on actual usage.
6. Add low-risk token additions (`info`, `--state-*-soft`, `.dark
   color-scheme`) without broad call-site churn.

Only move to PR 2 after PR 1 is green and reviewed.
