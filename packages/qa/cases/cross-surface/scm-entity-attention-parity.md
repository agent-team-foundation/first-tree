---
id: scm-entity-attention-parity
description: Verify that equivalent GitHub and GitLab MR/Issue activity produces the same First Tree attention, routing, lifecycle, and product projection.
areas: [cross-surface]
surfaces: [web, server, client, cli, github, gitlab]
---

# SCM Entity Attention Parity

## Goal

Verify provider-neutral user behavior for GitHub Pull Requests/Issues and GitLab Merge Requests/Issues while preserving
their protocol differences. Equivalent semantic activity must produce equivalent attention lines, chat selection, wake,
card significance, lifecycle projection, topic protection, and archive behavior.

## Preconditions

- Reach `QA READY` in an isolated run cell with disposable GitHub and GitLab projects, valid inbound webhook paths, a
  disposable Team, two human identities, eligible delegates, and at least two chats.
- Record provider delivery identifiers and redacted entity URLs. Do not retain credentials, installation tokens, GitLab
  webhook bearers, private payloads, or non-disposable identity data.
- Treat GitHub live validation and GitLab pending activation as intentional protocol differences. Begin paired assertions
  only after both attention lines are active.

## Operate and Observe

- For each provider, create an agent explicit follow in a chat with two active human members where neither human links the
  caller as delegate. Confirm the follow succeeds, the id-sorted-first active human is the stable line representative, and
  the calling agent remains the wake target. Then create a human explicit follow with a configured delegate. Confirm both
  paths store a complete human/wake-agent attention line, repeated same-pair follow is idempotent, a second-chat follow
  conflicts, and `--rebind` atomically moves only that pair. Also confirm exactly one explicit human-to-agent delegate link
  takes precedence over the stable fallback, while multiple explicit links fail closed.
- Deliver an ordinary subscribed comment/Note. Confirm one card per target chat, notifying Inbox entries for every
  surviving delegate, predictive sessions, and wake delivery. Provider actor attribution must not suppress the delegate.
- Unfollow in one chat and redeliver an ordinary event. Confirm the old chat stays silent. Then deliver an explicit
  reviewer, assignee, or exact body/comment mention and confirm a fresh route may be established without reviving the
  removed line.
- Exercise reviewer, assignee, and mention targets with equivalent identities. Only reviewer routing may reuse exactly one
  eligible membership chat without writing a new line; assignee and mention routing establish the target's own line/chat.
  Ambiguous membership reuse must fail closed.
- Deliver equivalent code updates, draft/ready transitions, description mentions, terminal state changes, and
  metadata-only updates. Confirm code updates are actionable, ready reviewers are actionable, description mentions route
  only on open or actual description change, and observation-only/metadata-only activity refreshes title/state without an
  extra card.
- Confirm provider-created topics use the provider's stable grammar (`PR`/`PR Review` or `MR`/`MR Review`, plus project
  basename and number) and update only while provider metadata proves the anchor and the current topic remains automatic.
  Manual topics remain unchanged. Confirm the Web header link uses the typed provider metadata URL and no link is guessed
  for a manual/follow-only chat.
- Let all mapped entities become terminal and the idle threshold elapse. Confirm unread state, open requests, and
  working/blocked runtime sessions independently prevent archive; otherwise the chat archives. Deliver a later event and
  confirm the archived chat revives.
- Compare `following`, the right sidebar, cards, Inbox rows, session/wake evidence, topics, header links, and archive
  outcomes side by side. Record only explicit protocol exceptions: authentication, GitLab pending activation, provider
  entity keys, webhook version compatibility, and delivery-id reliability.

## Expected Result

`PASS`: equivalent GitHub and GitLab semantic events produce the same observable attention-line ownership, rebind,
unfollow, target-chat, wake, card-significance, lifecycle, topic-protection, header-link, archive, and revive behavior;
only the declared protocol exceptions differ.

`FAIL`: either provider permits a silent complete attention line, duplicates a pair across chats, chooses a different
target-chat policy, delivers a semantically noisy card, leaks internal identifiers, overwrites a manual topic, guesses an
entity URL, or archives despite a safety guard.

`BLOCKED`: the complete isolated harness cannot receive both providers' disposable webhooks or cannot observe the required
Web, CLI, Inbox/session, and archive surfaces.

`INCONCLUSIVE`: only source, unit-test, database, or unattributable log evidence exists, or the providers cannot be compared
at equivalent active-line preconditions.

## Evidence

Keep redacted paired webhook outcomes, public `following`/sidebar projections, cards, Inbox/session/wake traces, topic and
header-link screenshots, archive/revive state, provider versions, delivery reliability notes, and command exit statuses.
Include one disposition for this case without editing it during the QA run.
