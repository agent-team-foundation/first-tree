---
id: gitlab-webhook-basic-card
description: Verify GitLab Settings, inbound cards, exact identity routing, reviewer capability, and silent delivery without Cloud egress or source-review claims.
areas: [cross-surface]
surfaces: [web, server, gitlab, client]
---

# GitLab Webhook and Personnel Routing

## Goal

Verify the assembled GitLab Settings and personnel-routing vertical slice: one-time URL bearer management, inbound-only
authentication, pending follows and basic cards, admin-managed exact username links, explicit Team-wide automatic-action
risk acceptance, capability-driven reviewer/legacy-assignee behavior, Note mentions, target-chat reuse/creation, and
silent delegate delivery. The case must also prove the Stage 4 boundary: a routed review request is not reported as running or
completed until a customer-side source mapping exists in a later phase.

## Preconditions

- Use an isolated Team, disposable GitLab project, and a connection whose instance origin is unreachable from the First
  Tree Cloud run cell but can send inbound webhooks to it.
- Record the generated webhook URL only in the customer's GitLab configuration; redact its bearer from QA evidence,
  logs, traces, screenshots, and shell history.
- Prepare two existing chats. Deliver an entity event before either chat follows it, then declare the same issue or
  merge-request URL in both chats. Bind one exact GitLab username to an active member whose eligible delegate runtime can
  be observed; keep one second username unbound for skipped-target evidence.

## Operate and Observe

- Use GitLab's Test delivery, then confirm connection health and endpoint observation change only from that
  inbound request. Confirm First Tree makes no request to the declared GitLab origin.
- Exercise Settings as an admin and member. Confirm the URL appears only in the create/regenerate/replace modal, is gone
  after closing, never reappears from refresh/cache/history, and ordinary members see only the redacted connection and
  health summary. While a secret response and destructive confirmation are open or pending, switch Teams and confirm the
  old Team's secret/confirmation/result never appears or mutates the newly selected Team. Confirm stale Replace returns a
  conflict instead of overwriting the current connection.
- Confirm the event sent before any follow left no standalone entity record and produced no mapping. Deliver the next
  Issue, Merge Request, and Note events for the followed entity. Confirm each pending declaration binds only
  when project path, numeric project id, entity type, and iid are consistent, and each processing pass writes at most one
  GitLab card to the existing chat.
- Rename the project, declare the new path before its next event, and verify the pending declaration collapses into the
  existing numeric mapping rather than duplicating or failing it. Confirm two projects with the same entity type and IID
  can coexist in one chat because GitLab IIDs are project-scoped.
- With automatic actions disabled, deliver reviewer, assignee, Note mention, and actor fields. Confirm only explicit-follow
  cards are delivered and every personnel target is skipped without a pending intent.
- Review and accept the Team-wide URL bearer forgery disclosure, enable automatic actions, and confirm the audit records the
  current administrator and time. Deliver a standard MR reviewer payload: the exact active link must resolve through the
  current membership to its eligible delegate, create or reuse one entity chat, and write one silent card without creating
  a notify-worthy inbox row or waking an agent. The card may say the review request was routed/source unavailable; it must
  not claim review running/completed.
- Deliver ordinary assignee and explicit Note `@mention` targets and confirm they route silently without being labelled as code
  review. Verify exact case-insensitive usernames only; display-name, email, similar-name, inactive link, inactive member,
  missing delegate, and ineligible delegate cases must skip independently and remain visible for seven days.
- Verify reviewer mode starts unknown. A valid top-level `reviewers: []` latches reviewers capability without a target.
  A modern update uses only the added `changes.reviewers` delta. Once reviewer capability is observed, missing/wrong-type
  reviewers or a custom template missing the delta produces a schema anomaly and never falls back to assignee. In an
  isolated legacy connection, admin confirmation may make assignee the review target until reviewers are observed.
- Suspend/revoke a username and remove/restore a member. Confirm identity-owned routing stops atomically, independent
  explicit follows continue receiving basic cards, membership restoration does not reactivate the link, and revoked links
  cannot be reconfirmed. Confirm the append-only identity audit retains create, suspend/leave, reconfirm, revoke, and
  connection-removal actor/time/reason snapshots across multiple transitions. A later admin reconfirmation requires a new
  upstream personnel event.
- Redeliver with the same stable provider delivery id and confirm whole-request deduplication. Deliver without a stable id
  and confirm no claim is stored; repeated cards are an accepted weak-reliability outcome.
- Regenerate the bearer and confirm the old URL stops authenticating immediately while the replacement URL is returned
  only once. Replace the Team's single GitLab connection and confirm the old connection, bearer, and entity/chat mappings
  are deleted atomically. Verify ordinary read APIs never return a bearer.
- Race an inbound delivery and a follow declaration with bearer regeneration or connection replacement. Once the admin
  operation returns, the old bearer must not update health or write a card, and a replaced connection must not retain
  stale mappings.
- Send a mismatched event header/body, malformed JSON, oversized body, wrong content type, and unsupported event. Expect
  explicit 4xx for malformed input and a successful no-op for a valid unsupported event, with no unsafe side effects.
- Send reviewer, assignee, and Note-mention payloads at the documented personnel-target boundary, then one above it.
  Boundary-sized payloads may process; over-limit payloads must return 4xx before claim, health mutation, target audit, or
  personnel routing.

## Expected Result

`PASS`: endpoint identity alone selects the Team and authority, secrets remain redacted, Cloud performs no GitLab egress,
the Team has at most one GitLab connection, supported entity events reach only existing followed chats as basic cards,
stable ids are connection-scoped, admin risk acceptance gates every personnel action, exact active identities route to the
current eligible delegate with one silent card per chat and no wake, anomalies fail closed, and no Stage 4 source-review
state is claimed.

`FAIL`: cross-Team resolution, secret exposure, any outbound request to GitLab, incorrect pending binding, duplicate cards
for one chat within one pass, an ungated/fuzzy/stale personnel action, any GitLab-triggered wake, reviewer downgrade, or a claim that
source review is running/completed.

`BLOCKED`: the isolated run cell cannot receive a disposable GitLab webhook or cannot create a disposable Team/chat/follow.

`INCONCLUSIVE`: only database or internal log evidence exists and the endpoint/card behavior cannot be attributed to the
tested deployment.

## Evidence

Keep redacted connection summaries, one-time-secret disappearance evidence, Test/event response classes, basic and routed
cards, silent-inbox/skipped/audit evidence, lifecycle outcomes, regeneration/replacement outcomes, and an egress observation. Never
retain a complete webhook URL, bearer, raw private payload, username list beyond disposable fixtures, or customer credential.
