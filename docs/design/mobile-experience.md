# First Tree Mobile Experience

This document defines the first production mobile experience for the First Tree
web app. It is a design-and-implementation contract for the mobile web surface,
not a second product, a native app plan, or a responsive patch over the desktop
console.

## Product Boundary

Mobile is the daily work surface. Desktop remains the management surface.

Mobile must optimize for:

- seeing what needs attention now
- answering agent questions
- continuing task conversations
- starting a task with a teammate or agent
- checking who is on the team
- switching account/team and adjusting personal preferences

Mobile must not expose first-phase management workflows such as agent creation,
agent runtime configuration, repository/resource administration, context tree
configuration, GitHub integration setup, or dense audit tables. Those workflows
remain desktop-only until a mobile use case is strong enough to justify a
dedicated mobile interaction model.

## Information Architecture

The mobile app has four primary tabs:

- `Now`: attention queue and current work.
- `Chat`: conversation list and full-screen chat detail.
- `Team`: humans and agents in one roster.
- `Me`: account, team switching, sign-out, theme, and personal settings.

The tab names are intentionally short. `Team` replaces an `Agent` tab because
First Tree is about human-agent collaboration, not agent inventory management.
Humans and agents are peers in the mobile roster.

## Routing

Mobile uses explicit `/m/*` routes inside the existing React web app:

- `/m` redirects to `/m/now`.
- `/m/now` shows the attention queue.
- `/m/chat` shows the mobile conversation list.
- `/m/chat?c=<chatId>` shows chat detail.
- `/m/chat?c=draft&with=<agentId>` starts a targeted draft chat.
- `/m/team` shows the mobile roster.
- `/m/me` shows account and personal controls.

Desktop routes are left intact. A mobile browser may still open desktop links,
but the mobile entry point is explicit so the product can evolve without
coupling every desktop page to mobile constraints.

## Design System Contract

Mobile uses the existing First Tree visual system as its source of truth:

- Inter remains the UI font.
- JetBrains Mono remains reserved for IDs, counters, and technical metadata.
- Existing neutral foreground/background tokens remain canonical.
- Existing state colors remain canonical: idle, working, blocked, needs-you,
  error, offline, unread.
- Existing radius tokens remain canonical: chip, input, panel, dialog, full.

Mobile adds a local component scale rather than redefining the global design
system:

- screen horizontal padding: `16px` on normal phones, reducible to `12px` on
  narrow edge cases
- top app bar: `48px`
- bottom tab bar: `56px` plus safe-area inset
- touch target minimum: `44px`
- list row minimum: `64px`
- action card minimum: `72px`
- composer input font: `16px` to avoid iOS zoom
- message/body text: `14px` to `16px` depending on density
- metadata/status text: `11px` to `12px`
- sheet/dialog radius: existing `--radius-dialog`, never oversized mobile cards

Mobile components must not depend on hover states. Every row action needs a
tap target, inline button, or action sheet. Color cannot be the only state
signal; status chips and badges must include text or an accessible label.

Motion is functional only:

- 150-220 ms for sheet, tab, and scrim transitions
- transform and opacity only
- no decorative motion
- respect `prefers-reduced-motion`

## Core Components

The first implementation should introduce mobile-specific components under the
web package rather than overloading the desktop `Layout`:

- `MobileShell`: route outlet, top bar, bottom tabs, safe-area management.
- `MobileTopBar`: current screen title, team anchor, compact actions.
- `MobileBottomTabs`: Now, Chat, Team, Me with unread/attention badges.
- `MobileNowPage`: attention-first work queue from existing chat rows.
- `MobileAttentionCard`: one actionable work item with status, title, summary,
  and primary action.
- `MobileChatPage`: list/detail router backed by `?c=`.
- `MobileChatList`: touch-sized conversation rows and filters.
- `MobileChatRow`: avatar, title, attention state, activity, time, unread.
- `MobileChatDetail`: full-screen wrapper around the existing chat center.
- `MobileTeamPage`: humans and agents roster, optimized for scanning.
- `MobileTeamMemberRow`: human/agent identity, role/state, primary chat action.
- `MobileMePage`: account identity, team switcher, theme, support, sign-out.
- `MobileActionSheet`: common action surface for row-level secondary commands.
- `MobileEmptyState`, `MobileLoadingState`, `MobileErrorState`: consistent
  system states across all mobile tabs.

Desktop primitives may be reused when they satisfy mobile constraints:

- `Avatar`
- `Button`
- `PresenceChip`
- `StateChip`
- `StatusGlyph`
- `TeamSwitcher`
- `ThemeToggle`
- `UserMenu` where the full menu remains appropriate
- existing chat APIs and React Query hooks

Desktop surfaces should not be reused as primary mobile UI:

- three-pane workspace shell
- desktop top nav
- desktop settings sidebar
- dense tables
- hover-only row menus
- agent configuration tabs
- context tree management screens

## Interaction Models

### Now

Now is not a generic dashboard. It is an action queue sorted by urgency:

1. open agent questions
2. failed or blocked work
3. unread mentions
4. active working chats
5. recently active chats

Each card needs one clear primary action. If the action is a chat action, the
card deep-links to `/m/chat?c=<chatId>`.

### Chat

Chat uses a two-level mobile model:

- `/m/chat`: conversation list.
- `/m/chat?c=<chatId>`: full-screen chat detail.

The bottom tab bar is hidden on chat detail so the composer owns the bottom of
the viewport and never collides with navigation. Returning to the list uses a
top-bar control or browser back.

### Team

Team is a roster, not a configuration page. Agents and humans are shown in one
mobile-scannable list with light grouping. The primary mobile action is starting
or continuing a chat. Details may open as sheets in later phases, but agent
configuration remains desktop-only.

### Me

Me owns account and local preferences:

- current user identity
- current team
- team switcher
- theme
- support links
- sign-out

Admin settings remain desktop-only in the first phase. Me may link to desktop
settings for full management.

## Technical Delivery

Mobile ships inside `packages/web` as a separate shell:

```text
packages/web/src/pages/mobile/
  shell.tsx
  now.tsx
  chat.tsx
  team.tsx
  me.tsx
  components.tsx
```

Shared business logic should be extracted only when reuse is real. First-phase
mobile code may duplicate small presentation decisions to avoid destabilizing
desktop surfaces. Shared API helpers, auth context, React Query, and UI tokens
remain reused.

No server changes are required for the first phase. The existing endpoints
already provide enough data:

- `GET /orgs/:orgId/chats`
- `GET /agents` and `GET /agents/all`
- `GET /members`
- `GET /clients`
- `GET /me`

If later phases need a stronger attention queue, add a server-side projection
after the mobile usage model proves the ranking. Do not introduce client-only
business rules that become invisible product policy.

Current implementation handoff lives in `docs/design/mobile-handoff.md`.

## First Phase Scope

The first phase must make the mobile product visible and usable:

- add authenticated `/m/*` routes
- add mobile shell with safe-area-aware top and bottom chrome
- implement Now from existing chat rows
- implement Chat list/detail routing
- implement Team roster with humans and agents
- implement Me account controls
- keep desktop routes unchanged
- add route and projection tests for the new mobile surface

First phase is complete only when a phone-width viewport can navigate through
Now, Chat, Team, and Me without horizontal overflow, hover-only controls, or
composer/tab overlap.

## QA Gate

Before merging implementation:

- run `pnpm --filter @first-tree/web typecheck`
- run focused web tests for mobile routes and projection helpers
- inspect 320, 375, 390, 430, and 768 CSS-pixel widths
- inspect light and dark mode
- verify iOS-safe input sizing on composer/search fields
- verify bottom tabs do not overlap scroll content
- verify chat detail hides bottom tabs
- verify keyboard focus is logical through top bar, content, and bottom tabs
- verify all icon-only controls have accessible names

## Maintenance Rules

Every future feature should answer one question before reaching mobile:

Does this help a user act on work from a phone?

If yes, design a mobile-native path. If no, keep the feature desktop-only and
provide a clear handoff link where needed. Mobile should stay small, fast, and
action-oriented rather than becoming a compressed copy of the desktop console.
