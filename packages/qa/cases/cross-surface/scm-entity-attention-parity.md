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
  When two agent-issued lines share the same fallback human and chat, suspend one wake agent without deleting its mapping
  or membership, then redeliver. Confirm the card still lands once, the active sibling is the only native mention and wake,
  and the suspended sibling receives no notifying Inbox entry.
- Unfollow in one chat and redeliver an ordinary event. Confirm the old chat stays silent. Then deliver an explicit
  reviewer, assignee, or exact body/comment mention and confirm a fresh route may be established without reviving the
  removed line.
- Exercise reviewer, assignee, and mention targets with equivalent identities. Confirm review-only routing reuses exactly
  one chat only when the target human and current delegate are already speakers, and writes no new line. For assignment
  and mention, create an agent follow whose stable human carrier has a different current delegate. Confirm one uniquely
  safe entity chat is reused, the current delegate is atomically admitted when necessary, and an exact sibling line is
  written without deleting or replacing the original follow line. The chat must receive one card and wake the fresh
  delegate. Repeat with `review_requested` plus `assigned`; the card must display review priority while still persisting
  the sibling line.
- Repeat assignment and mention with zero candidates, two otherwise-safe candidates, another human speaker, another
  owner's non-human speaker, and an invitation-denied target. Confirm every valid-but-unsafe or ambiguous case creates a
  strict exact-pair home, never picks by human or manager, and never writes a personnel
  `human_fallback`/`identity_target` into an unselected chat. Resolve the audience, then change the delegate, suspend the
  human or delegate, or deactivate the human membership before placement; stale authority must be dropped without
  accepting an old direct line or creating a new home. After unfollow, an explicit mention may create a fresh route but
  must not revive the removed chat.
- Race webhook personnel placement against unfollow and `--rebind` for the same entity. Confirm all operations serialize:
  the final exact line follows the winning current state, no old chat is resurrected, membership never commits without
  its sibling mapping, and concurrent fresh targets converge to at most one exact home. Also race placement against
  removing the target delegate from the candidate chat and transferring an existing private speaker to another owner;
  the result must either remain safely wakeable in the candidate or fail over to a strict home without exposing private
  history. During explicit GitHub and GitLab follow/rebind, change the human's delegate or remove the wake agent from the
  destination chat after request authorization but before persistence; both providers must reject the stale pair and
  leave the previous line unchanged.
- Rename a GitLab project after an entity has been observed, then race webhook observation using the new path against
  follow/unfollow using the previously stored path or mapping id. Confirm the numeric project id keeps both paths in one
  entity serialization boundary and the final active line reflects the winning operation without stale resurrection.
- Have a delegate act through its human's provider identity in an entity followed by that human's line. Confirm every
  valid routed chat keeps one provider card, the matching existing line does not wake itself, eligible sibling lines still
  wake, and a chat with no eligible wake line receives a silent history card instead of losing the event.
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

`FAIL`: either provider permits a complete attention line to become permanently unwakeable, drops an actor-authored card,
duplicates a pair across chats, chooses a different target-chat policy, delivers a semantically noisy card, leaks internal
identifiers, overwrites a manual topic, guesses an entity URL, or archives despite a safety guard.

`BLOCKED`: the complete isolated harness cannot receive both providers' disposable webhooks or cannot observe the required
Web, CLI, Inbox/session, and archive surfaces.

`INCONCLUSIVE`: only source, unit-test, database, or unattributable log evidence exists, or the providers cannot be compared
at equivalent active-line preconditions.

## Evidence

Keep redacted paired webhook outcomes, public `following`/sidebar projections, cards, Inbox/session/wake traces, topic and
header-link screenshots, archive/revive state, provider versions, delivery reliability notes, and command exit statuses.
Include one disposition for this case without editing it during the QA run.
