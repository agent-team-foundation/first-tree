---
id: onboarding-first-chat-orientation
description: Validate the optional first-chat Orientation and its single transition into existing agent task guidance.
areas: [cross-surface]
surfaces: [web, server, client, runtime]
---

# First-chat Orientation Handoff

## Goal

Confirm that an ordinary onboarding chat presents one immediately skippable Orientation before any agent task guidance,
then produces exactly one normal agent wake with the original visible bootstrap as context. This case owns the live
Web → kickoff API → Inbox → runtime boundary that deterministic component and service tests cannot prove.

## Preconditions

- Use isolated fresh admin and invited-member accounts plus active target agents. Include a Team agent whose connected
  computer belongs to another member so the security copy can be judged without assuming the viewer owns that runtime.
- Keep the target runtime connected and observable, but do not let it receive unrelated work during the run.
- Have a current Web bundle and a legacy-capability request fixture that omits `orientation`; do not use campaign-action
  or dedicated Context Tree setup kickoffs as the positive path.

## Operate and observe

1. Start an ordinary onboarding chat. The one visible bootstrap renders one inline Orientation with four choices:
   multi-agent collaboration, Context Tree, GitHub automation, and data/security. The runtime receives no initial wake.
2. Without choosing a chapter, use the one global skip action. It sends one visible human continuation and only then
   wakes the target agent. Verify the runtime receives that continuation with the bootstrap as preceding context and
   follows the existing `first-tree-welcome` task-guidance lane rather than treating the turn as an ordinary task.
3. Repeat with a fresh account, choose any chapter, inspect the placeholder transcript, and start. The chapter view
   replaces the choice list rather than creating a tall stacked tutorial. The same single continuation and wake occur.
4. Repeat with a fresh account and ignore the card. Send a normal composer message. It implicitly closes Orientation,
   preserves the typed content, wakes the agent once, and leaves a compact history entry that can be watched again
   without another wake.
5. Reload before and after continuation, retry the kickoff, and exercise concurrent kickoff requests. One chat and one
   bootstrap remain; pending Orientation never duplicates or traps the user, and completed history does not reopen as a
   blocking step.
6. Age the pending Orientation bootstrap beyond the ordinary silent-context replay window, then continue. The runtime
   still receives the bootstrap as preceding context. Separately create with the current capability and retry the same
   keyed kickoff without it: the server converts the existing bootstrap to the legacy immediate-wake behavior instead
   of leaving an unrenderable silent chat.
7. Before completing a fresh Orientation, add another participant and address only that participant. The message wakes
   only its stated recipient, does not receive the onboarding bootstrap, and leaves Orientation pending for the original
   target. Remove the original target and repeat: messages to remaining participants still work while Orientation stays
   pending, and a send to the removed target fails through ordinary routing validation. Re-add the original target, then
   address it and the added participant together: both receive the visible turn, but only the original target receives
   the bootstrap and consumes the one-time handoff.
8. After completing Orientation, add another participant and let the marked bootstrap age beyond the ordinary replay
   window. Address that participant on a later unrelated turn and verify the old bootstrap is not replayed. Also load a
   completed chat history slice containing the bootstrap but not the original continuation: the card stays compact from
   the server lifecycle and cannot enqueue another first wake.
9. Start a fresh kickoff with the capability omitted. It retains the legacy immediate wake. Verify campaign action,
   dedicated tree setup, and ordinary chat messages never render or accept the trusted Orientation marker.
10. At a narrow phone viewport, the initial chapter choice plus global skip are visible without traversing an empty video
   well, the selected chapter remains usable without horizontal overflow, and every action is keyboard and touch
   reachable. Verify the Team-agent security chapter uses team/agent-neutral ownership language.

## Expected result and evidence

`PASS` requires one bootstrap, no pre-continue runtime turn, one visible continuation, one agent wake, correct preceding
context and `first-tree-welcome` behavior, working skip/chapter/direct-message branches, durable reload/retry behavior,
original-target-bound continuation and replay, bounded replay after completion, legacy reconciliation, and
campaign/tree/ordinary-chat exclusion. `FAIL` includes an early or duplicate wake, lost or stale bootstrap context, a
handoff consumed by or replayed to the wrong participant, a reopened completed Orientation, inaccessible skip,
ownership-misleading security copy, or a marker accepted from an untrusted send.

Keep the exact tested commit/build, redacted network request shapes, message and Inbox ordering, runtime turn evidence,
and desktop/narrow screenshots. Do not retain tokens, message bodies from real repositories, or private identifiers.
