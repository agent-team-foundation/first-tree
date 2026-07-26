---
id: people-picker-long-identities
description: Verify long agent display names and handles stay single-line, readable, and viewport-safe across people-picker surfaces.
areas: [cross-surface]
surfaces: [web]
---

# Long identities across people pickers

## Goal

Verify that every Web surface used to find or select a person applies the same
single-line identity contract: display names and `@handles` ellipsize instead
of wrapping or widening their panel, selected chips remain bounded, and the
full identity is available from the row or chip title. The new-chat `[+]`
picker must remain fully reachable even when preceding recipient chips push its
inline trigger toward the viewport edge.

Deterministic product tests own identity-title formatting and placement math.
This case owns rendered geometry across the assembled responsive surfaces,
where DOM-only tests cannot prove clipping, wrapping, or horizontal overflow.

## Preconditions

- Use an isolated Docker plus temporary-worktree QA run cell with the Web app,
  server, database, and a real browser available.
- Seed at least four active, selectable agents: a short display name/handle, a
  long CJK display name with a long handle, a long unbroken Latin display name,
  and two agents sharing the same display name so handle disambiguation renders.
- Open the same data at desktop width, 390px, and the supported 320px mobile
  baseline. Do not rely on browser zoom as a substitute for actual viewport
  dimensions.

## Operate and observe

- Open the chat-header/right-sidebar add-participant picker, composer `@`
  suggestions, new-chat recipient picker and selected chips, Team delegate
  selector, and Workspace People filter. Confirm every identity label stays on
  one line; ellipses appear where needed; handles never break mid-token; rows
  keep their normal height; and the panel/page gains no horizontal scrollbar.
- Hover or otherwise inspect each truncated row and selected chip. Its title
  must expose the complete `Display name (@handle)` identity without duplicate
  text when display name and handle are the same.
- In New Chat at 390px, select a short-name recipient, reopen `[+]`, then repeat
  after selecting a long-name recipient and after selecting both. Confirm the
  picker is portalled above clipping ancestors, its left and right borders are
  visible, search and every option remain reachable, and choosing an option
  still commits it.
- Repeat that chip-offset scenario at 320px. Confirm both panel edges retain an
  inset from the visual viewport and the panel neither clips nor creates page
  horizontal scroll. Resize/orient the viewport while it is open and confirm it
  re-clamps to the new visual viewport.
- Use keyboard navigation in the open new-chat picker: focus lands in search,
  Arrow keys move the active option, Enter selects it, Escape closes it, and an
  outside click closes it without making portal rows unclickable.

## Evidence

Keep screenshots for each surface with the long CJK and unbroken Latin
identities, plus before/after screenshots of the 390px and 320px new-chat
chip-offset scenarios showing both picker borders. Record viewport dimensions,
panel bounding rectangles, `documentElement.scrollWidth/clientWidth`, visible
row heights, title values, and any browser console errors. Do not capture
private profile content beyond the synthetic seeded identities.

## Expected result

`PASS`: all picker rows and chips follow the one-line contract; full identities
remain discoverable; no tested surface widens, wraps, or gains horizontal
scroll; and the new-chat picker stays fully inside both 390px and 320px visual
viewports before and after chip offsets and resize.

`FAIL`: any identity wraps or breaks mid-token, a title loses identity data, a
panel/page overflows horizontally, either new-chat picker edge becomes
unreachable, or portal positioning breaks mouse or keyboard selection.

`BLOCKED`: the isolated run cell cannot seed agents, start the Web surface, or
drive a real browser at the required viewport sizes.

`INCONCLUSIVE`: geometry or title evidence is missing, unstable, or cannot be
attributed to the tested ref.
