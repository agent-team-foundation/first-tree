---
title: "User Experience Design Skills"
owners: [liuchao-001]
soft_links: [kael/NODE.md]
---

# User Experience Design Skills

A set of actionable UX principles for building and reviewing user interfaces. Each principle is abstract enough to apply broadly, with concrete examples from real product refinement.

Intended use: as a reference skill for AI agents performing UI review, UI testing, or UX polish.

---

## Principles

### 1. No Flaky UI

The interface must never flicker, jump, or change state unexpectedly. Every visual transition must be intentional and predictable.

- Async data arriving after render must not rearrange the current view or override user navigation.
- Dialogs must reset to a clean initial state on close — never resume from stale intermediate state.
- Loading states must occupy the same layout space as the loaded content to prevent layout shift.
- **No premature defaults.** If a value depends on async data, show a skeleton/placeholder until the data arrives — never render a default value that gets replaced moments later. A button labeled "Connect" that flips to "Manage" after 200ms is a flicker. Show nothing (or a shimmer) until you know the answer.
- Page layout before and after loading must be structurally stable. Blocks of content must not appear, disappear, or rearrange once the page is interactive.

> *Example:* A setup dialog has two modes. If the user is browsing mode A and async data for mode B arrives, the dialog must not jump to mode B. The user's explicit navigation always takes priority over data-driven state changes.

### 2. Information Density — Say It Once, Say It Right

Every piece of text, label, and instruction must earn its place. Eliminate redundancy, reduce cognitive load, and keep the interface scannable.

- Don't repeat what the UI already communicates visually (e.g., don't label a green checkmark "Success").
- Instructions for external actions must be precise and specific — list exact navigation paths rather than vague directions.
- If a label or description can be removed without losing meaning, remove it.

> *Example:* Instead of "Go to Feishu Open Platform and configure the webhook," write: "In Feishu Open Platform → your app → Events & Callbacks. Paste this URL in: 1. Event Configuration → Request URL, 2. Callback Configuration → Request URL." Precise instructions prevent user errors during context-switching.

### 3. Visual Balance

Layout, spacing, and element placement must feel balanced and intentional. The user's eye should flow naturally through the interface.

- Align related actions. Primary actions go right-aligned or at the natural reading endpoint.
- Don't cluster too many buttons in one row. When two buttons serve a sequential purpose, merge them into one context-aware button.
- Maintain consistent spacing between sections. Use the same padding/margin patterns throughout a flow.

> *Example:* A form step shows "Save and Continue" alongside "Next Step." This forces the user to choose between two forward-moving actions. A single "Next Step" button that auto-saves when changes exist is visually cleaner and removes a decision the user shouldn't need to make.

### 4. Minimum Necessary Steps

Reduce the number of actions required to complete a task. Every click, selection, and confirmation must be justified.

- If the system can infer the user's intent, don't ask them to state it explicitly.
- Collapsed/expandable sections that always need expanding are wasted interactions — show the content directly.
- After a multi-step flow completes, transform the UI to reflect completion. Hide backward navigation and show a single Done action.

> *Example:* Returning to step 1 from step 2 showed a collapsed read-only view requiring an "Edit" click to expand. Since the user navigated back to edit, showing the form fields directly saves one interaction.

### 5. Responsive Feedback

Every user action must produce immediate, visible feedback. The user should never wonder "did that work?"

- Buttons must show loading state during async operations ("Validating..." with spinner).
- Success and error states must be visually distinct and appear without delay.
- Temporary feedback (e.g., "Copied") must use a muted visual style (gray, non-interactive) to distinguish it from the actionable state ("Copy" in brand color).
- After a flow completes, the parent view must immediately reflect the new state (e.g., "Connected" badge) without requiring manual refresh.

> *Example:* A "Copy" button shows "Copied" in the same brand-primary color — the user can't tell at a glance if it's still clickable. "Copied" should be gray and disabled during the feedback window.

### 6. Errors in Context

Error messages must appear where the error occurred, not in a transient notification that disappears before the user can act.

- Validation errors belong inline, near the relevant form fields — not in a toast.
- Errors must persist until the user addresses them, and clear automatically when the user starts editing the relevant field.
- Error text must be specific and actionable: state what went wrong and what to do about it.

> *Example:* Credential validation fails. A toast notification appears for 3 seconds and vanishes. The user didn't read it. An inline error below the form fields persists until they fix the input — and clears the moment they start typing.

### 7. State Simplicity

Derive UI states (connected, active, error) from the minimum necessary data. Complex multi-source status logic creates edge cases and stale states.

- One clear signal should determine a state — don't require three separate records all to be true.
- When the underlying data model changes, simple state derivation is more resilient than complex relationship chains.
- Connected means credentials are valid. Active means the service responds. Don't conflate ownership, binding, and configuration into a single status check.

> *Example:* "Connected" status was derived from a binding record + ownership check + separate config table. Simplified to: valid credentials saved = connected. Fewer moving parts, fewer bugs.

### 8. Graceful Completion

When a multi-step process reaches its goal, the UI must clearly signal "you're done" and close the loop.

- Replace navigation controls (Back, step indicators) with a single completion action (Done).
- The completion action should return the user to the parent context with the updated state already visible.
- Don't offer destructive actions (Disconnect, Reset) immediately after a successful setup — that's hostile UX.

> *Example:* After bot verification succeeds, the dialog showed Back + Disconnect buttons. Replaced with a single "Done" button that closes the dialog and shows the "Connected" badge on the integration card.

### 9. Hide Implementation Details

Users care about what a system does for them, not how it works internally. Technical identifiers, API keys, internal IDs, and system architecture details must never appear in user-facing views.

- Management views should show human-meaningful information only: name, avatar, status badge, and action buttons.
- Technical fields (App ID, API keys, tokens, internal record IDs) belong in setup/configuration flows, not in status or management views.
- When the same entity has both a "setup" flow and a "management" view, keep them clearly separated. Setup is where technical details are entered; management is where the user monitors and controls.
- If a destructive or advanced action (e.g., editing credentials) requires technical details, gate it behind an explicit action ("Edit Configuration") rather than showing everything by default.

> *Example:* A bot management view displayed App ID (`cli_a936...`) alongside the bot's avatar and name. The App ID is meaningless to users checking their bot's status. Removed it — the management view now shows only the bot profile (avatar + name), connection status badge, and two action buttons (Edit Configuration, Disconnect). Technical details are only visible when the user explicitly enters the configuration editor.

### 10. Intentional Spacing

White space is a structural element, not leftover room. Every gap between UI elements must be deliberate — too tight feels cramped and hard to parse, too loose feels disconnected and wasteful.

- Establish a consistent spacing scale (e.g., 4/8/12/16/24/32px) and use it everywhere. Ad-hoc pixel values create visual noise that users feel but can't articulate.
- Group related elements with tight spacing; separate unrelated groups with wider spacing. Proximity is how users understand relationships — items close together feel like a unit.
- Padding inside containers (cards, dialogs, sections) must match the content density. A sparse dialog with tight padding feels suffocating; a dense form with generous padding wastes screen real estate.
- Vertical rhythm matters: headings, body text, form fields, and action buttons should follow a predictable cadence. When the rhythm breaks, users lose their scanning flow.
- Don't compensate for spacing issues by adding dividers or borders. If you need a line to separate two sections, the spacing between them is probably wrong.

> *Example:* A management dialog shows an avatar, bot name, status badge, and two action buttons stacked vertically. Each element has different margins — 8px, 16px, 12px, 20px — creating a subtly uneven layout. Standardizing to 12px between inline elements and 16px between sections produces a clean, rhythmic flow without needing any visible separators.

---

## How to Use This Skill

**For UI review / testing:**
1. Walk through each interaction against these 10 principles.
2. Flag violations by principle number (e.g., "P1: async data causes layout jump").
3. Propose specific fixes, not abstract suggestions.

**For building new UI flows:**
1. Design the happy path. Apply principles 2–4 (density, balance, minimum steps) to simplify.
2. Add error and loading states. Apply principles 5–6 (feedback, errors in context).
3. Test the "close and reopen" pattern — does the dialog reset cleanly? (Principle 1)
4. Verify completion flow — does the parent view update? (Principle 8)
5. Audit every visible field — does the user need to see this? (Principle 9)
6. Check spacing consistency — are gaps between elements deliberate and rhythmic? (Principle 10)

---

## References

These principles draw from established UX research, adapted for AI agent workflows:

- **Nielsen's 10 Usability Heuristics** — Visibility of system status, error prevention, aesthetic and minimalist design, help users recover from errors.
- **Fitts's Law** — Reduce distance and increase target size for frequent actions (inline buttons > distant button bars).
- **Hick's Law** — Fewer choices = faster decisions (one button > two buttons for the same intent).
- **Miller's Law** — Chunk information into scannable groups (step indicators, numbered instructions).
