---
id: gitlab-webhook-basic-card
description: Verify URL-bound GitLab ingress resolves only its configured Team and delivers basic cards to existing follows without personnel actions or Cloud egress.
areas: [cross-surface]
surfaces: [server, gitlab]
---

# GitLab Webhook Basic Card

## Goal

Verify the assembled GitLab Stage 2A path: one-time URL bearer creation, inbound-only endpoint authentication,
connection-scoped whole-request claim when GitLab supplies a stable id, pending-follow resolution from the next matching
webhook, and one basic card per already-following chat. This case must also prove that Stage 3 personnel behavior remains
off: no reviewer/assignee/mention target chat, wake, review task, or actor echo pruning.

## Preconditions

- Use an isolated Team, disposable GitLab project, and a connection whose instance origin is unreachable from the First
  Tree Cloud run cell but can send inbound webhooks to it.
- Record the generated webhook URL only in the customer's GitLab configuration; redact its bearer from QA evidence,
  logs, traces, screenshots, and shell history.
- Prepare two existing chats. Deliver an entity event before either chat follows it, then declare the same issue or
  merge-request URL in both chats. Do not pre-seed numeric GitLab identity in First Tree.

## Operate and Observe

- Use GitLab's Test delivery, then confirm connection health and endpoint observation change only from that
  inbound request. Confirm First Tree makes no request to the declared GitLab origin.
- Confirm the event sent before any follow left no standalone entity record and produced no mapping. Deliver the next
  Issue, Merge Request, and Note events for the followed entity. Confirm each pending declaration binds only
  when project path, numeric project id, entity type, and iid are consistent, and each processing pass writes at most one
  GitLab card to the existing chat.
- Rename the project, declare the new path before its next event, and verify the pending declaration collapses into the
  existing numeric mapping rather than duplicating or failing it. Confirm two projects with the same entity type and IID
  can coexist in one chat because GitLab IIDs are project-scoped.
- Confirm no new personnel-target chat, agent wake, automatic review task, or actor echo pruning occurs even if the payload
  includes assignee, reviewer, mention-like, or actor fields.
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

## Expected Result

`PASS`: endpoint identity alone selects the Team and authority, secrets remain redacted, Cloud performs no GitLab egress,
the Team has at most one GitLab connection, supported entity events reach only existing followed chats as basic cards,
stable ids are connection-scoped, and every Stage 3 personnel action remains absent.

`FAIL`: cross-Team resolution, secret exposure, any outbound request to GitLab, incorrect pending binding, duplicate cards
for one chat within one pass, personnel action, or endpoint lifecycle behavior outside the contract.

`BLOCKED`: the isolated run cell cannot receive a disposable GitLab webhook or cannot create a disposable Team/chat/follow.

`INCONCLUSIVE`: only database or internal log evidence exists and the endpoint/card behavior cannot be attributed to the
tested deployment.

## Evidence

Keep redacted connection summaries, Test/event response classes, the basic cards, regeneration/replacement outcomes, and an
egress observation. Never retain a complete webhook URL, bearer, raw private payload, or customer credential.
