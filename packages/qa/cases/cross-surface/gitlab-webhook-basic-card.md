---
id: gitlab-webhook-basic-card
description: Verify simplified GitLab Settings, inbound cards, exact identity routing, version-aware reviewer compatibility, and GitHub-aligned agent wake without Cloud egress or source-review claims.
areas: [cross-surface]
surfaces: [web, server, gitlab, client]
---

# GitLab Webhook and Personnel Routing

## Goal

Verify the assembled GitLab Settings and personnel-routing vertical slice: one-time URL bearer management, inbound-only
authentication, pending follows and basic cards, admin-managed exact username links, version-aware reviewer/legacy-assignee
behavior, Note mentions, target-chat reuse/creation, and delegate session/wake delivery. The case must also prove the
source-review boundary: a routed review request is not reported as running or
completed until a customer-side source mapping exists in a later phase.

## Preconditions

- Use an isolated Team, disposable GitLab project, and a connection whose instance origin is unreachable from the First
  Tree Cloud run cell but can send inbound webhooks to it.
- Record the generated webhook URL only in the customer's GitLab configuration; redact its bearer from QA evidence,
  logs, traces, screenshots, and shell history.
- Prepare two existing chats. Deliver an entity event before either chat follows it, then declare the same issue or
  merge-request URL in both chats through `first-tree gitlab follow`. Bind one exact GitLab username to an active member whose eligible delegate runtime can
  be observed; keep one second username unbound for structured skipped-target diagnostics.

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
- Before that matching webhook, run `first-tree gitlab following` in both chats and confirm the stable public projection
  reports `pending` without connection, organization, mapping, actor, normalized-path, or timestamp fields. After the
  webhook, confirm both independent chat declarations report `active`, the latest URL/title/state projection is visible,
  and First Tree made no outbound request to GitLab during follow or list.
- Rename the project, declare the new path before its next event, and verify the pending declaration collapses into the
  existing numeric mapping rather than duplicating or failing it. Confirm two projects with the same entity type and IID
  can coexist in one chat because GitLab IIDs are project-scoped.
- Deliver a standard MR reviewer payload: the exact active link must resolve through the current membership to its eligible
  delegate, create or reuse one entity chat, create a notify-worthy inbox row, establish the predictive session, and wake
  the delegate. The card may say the review request was routed/source unavailable; it must not claim source review
  running/completed.
- Deliver ordinary assignee and explicit Note `@mention` targets and confirm they route and wake without being labelled as
  code review. Verify exact case-insensitive usernames only; display-name, email, similar-name, inactive link, inactive
  member, missing delegate, and ineligible delegate cases must skip independently and emit only bounded operational logs.
- Verify reviewer mode starts unknown. For `User-Agent: GitLab/15.3.0` or newer, a missing `reviewers` field means no
  reviewer and never falls back to assignee; a valid top-level `reviewers: []` proves modern capability without a target.
  For an older declared version, use assignee as reviewer only when `reviewers` is absent. If the version is unavailable or
  malformed, prefer a valid reviewers field and otherwise use the assignee fallback without latching a mode. A modern
  update uses only the added `changes.reviewers` delta, malformed reviewer evidence fails closed, and modern mode never
  downgrades after an older declaration.
- Remove a username binding and remove/restore a member. Confirm future identity-owned routing stops, independent explicit
  follows continue receiving basic cards, membership restoration does not reactivate the suspended link, and admin
  reconfirmation restores that same current binding in place. A later reconfirmation requires a new upstream personnel
  event.
- Run `first-tree gitlab unfollow <current-url>` in one chat and confirm every automatic or manual binding for that entity
  is removed from only that chat; the other chat remains followed. Repeat unfollow and require `{ removed: 0 }` terminal
  success. Then deliver a new event that explicitly targets the linked reviewer/assignee/mention identity and confirm it
  may create a new route after the prior chat unfollowed. Do not require GitLab availability for unfollow.
- Queue a personnel wake, then remove the binding, remove the member, change the delegate, or replace the connection before
  the Inbox drains. Confirm subsequent webhooks use the new authority state while the already accepted wake retains generic
  at-least-once delivery and may still reach the old delegate once, matching GitHub Inbox behavior.
- Redeliver with the same stable provider delivery id and confirm whole-request deduplication. Deliver without a stable id
  and confirm no claim is stored; repeated cards are an accepted weak-reliability outcome.
- Regenerate the bearer and confirm the old URL stops authenticating immediately while the replacement URL is returned
  only once. Confirm regeneration also clears the learned GitLab version/reviewer mode so the new bearer learns afresh.
  Replace the Team's single GitLab connection and confirm the old connection, bearer, identity links, and entity/chat
  mappings are deleted atomically. Verify ordinary read APIs never return a bearer.
- Race an inbound delivery and a follow declaration with bearer regeneration or connection replacement. Once the admin
  operation returns, the old bearer must not update health or write a card, and a replaced connection must not retain
  stale mappings.
- Send a mismatched event header/body, malformed JSON, oversized body, wrong content type, and unsupported event. Expect
  explicit 4xx for malformed input and a successful no-op for a valid unsupported event, with no unsafe side effects.
- Confirm unresolved or ineligible personnel targets emit bounded structured operational diagnostics but create no
  provider-owned audit row, Settings history, pending target intent, chat, or mapping.
- Send reviewer, assignee, and Note-mention payloads at the documented personnel-target boundary, then one above it.
  Boundary-sized payloads may process; over-limit payloads must return 4xx before claim, health mutation, diagnostics, or
  personnel routing.

## Expected Result

`PASS`: endpoint identity alone selects the Team and authority, secrets remain redacted, Cloud performs no GitLab egress,
the Team has at most one GitLab connection, supported entity events reach only existing followed chats as basic cards,
stable ids are connection-scoped, exact active identities route to the current eligible delegate with one card per chat and
a generic at-least-once wake, agent follow/list/unfollow expose only the stable URL contract, chat-scoped unfollow removes
automatic and manual bindings while later directed events may route afresh, anomalies fail closed, and no source-review
state is claimed.

`FAIL`: cross-Team resolution, secret exposure, any outbound request to GitLab, incorrect pending binding, duplicate cards
for one chat within one pass, a fuzzy personnel match, new personnel routing after its authority was removed, reviewer
downgrade, or a claim that source review is running/completed.

`BLOCKED`: the isolated run cell cannot receive a disposable GitLab webhook or cannot create a disposable Team/chat/follow.

`INCONCLUSIVE`: only database or internal log evidence exists and the endpoint/card behavior cannot be attributed to the
tested deployment.

## Evidence

Keep redacted connection summaries, one-time-secret disappearance evidence, Test/event response classes, basic and routed
cards, inbox/session/wake evidence, lifecycle outcomes, regeneration/replacement outcomes, and an egress observation. Never
retain a complete webhook URL, bearer, raw private payload, username list beyond disposable fixtures, or customer credential.
