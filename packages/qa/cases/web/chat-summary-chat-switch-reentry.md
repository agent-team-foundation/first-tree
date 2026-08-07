---
id: chat-summary-chat-switch-reentry
description: A user switching chats can recover the selected chat's current state without replaying its history.
areas: [web]
surfaces: [web, server]
---

# Chat Summary chat-switch re-entry

Validate that Chat Summary acts as the selected chat's re-entry brief in the real Workspace, not as a static preview or
a detached task report.

Use a disposable signed-in member with at least two visible chats in the same Team. Give each chat a clearly different
topic and Markdown description containing a result line, short supporting context, and one next step. Prefer the
writing-contract shape (first physical line, then supporting lines) so lead promotion can be judged against real
agent output, not only blank-line paragraphs. Exercise the real Workspace against a real server and database; do not
substitute a `/preview/*` route or an operator's existing browser session.

Switch between the chats from the conversation list and confirm that the selected topic, expanded Current state panel,
freshness, and description all move together. The first physical line should be visibly scannable as the lead,
supporting copy should be quieter, the expanded card should span the same width as the chat header and the collapsed
bar it drops from — with its copy following that width rather than wrapping at a measure of its own — and
content from the previously selected chat must not remain. Collapse the panel and confirm its one-line result preview
still identifies the selected chat while the supporting copy no longer covers the message stream. Include legacy
Markdown such as a reference link or block-first content when the run is intended to assess compatibility as well as
the primary flow.

Credible evidence identifies the exact build, disposable identity and seeded chats, records both selections and the
expanded-to-collapsed transition, and links an uploaded browser run or equivalent screenshots/video. A result is not a
pass if it only demonstrates the development preview, if the descriptions bypass the real server read path, or if
shared state prevents attributing the selected summary to the exact chat.
