---
id: onboarding-first-chat-orientation
description: Validate the optional first-chat Orientation and its single transition into existing agent task guidance.
areas: [cross-surface]
surfaces: [web, server, client, runtime]
---

# First-chat Orientation Handoff

## Goal

Confirm that an ordinary onboarding chat presents one immediately skippable, senderless Orientation before any agent
task guidance, then produces exactly one normal agent wake with the stored bootstrap as preceding context. This case owns the live
Web → kickoff API → Inbox → runtime boundary that deterministic component and service tests cannot prove.

## Preconditions

- Use isolated fresh admin and invited-member accounts plus active target agents.
- Keep the target runtime connected and observable, but do not let it receive unrelated work during the run.
- Have a current Web bundle and a legacy-capability request fixture that omits `orientation`; do not use campaign-action
  or dedicated Context Tree setup kickoffs as the positive path.

## Operate and observe

1. Start an ordinary onboarding chat. The timeline renders one senderless, full-width Orientation rather than the
   bootstrap body, sender avatar, name, timestamp, or read receipt. It offers three persistent chapters: multi-agent
   collaboration, Context Tree, and GitHub automation. The runtime receives no initial wake.
2. Without choosing a chapter, use the header **Skip intro** action. It sends one visible human continuation and only then
   wakes the target agent. Verify the runtime receives that continuation with the bootstrap as preceding context and
   follows the existing `first-tree-welcome` task-guidance lane rather than treating the turn as an ordinary task.
3. Repeat with a fresh account, choose any chapter, and use **Start with <agent>**. The chapter list stays available while
   one selected video is shown. No transcript control is permanently visible; force a video load failure and verify its
   transcript appears directly in the error state with a retry action. The same single continuation and wake occur.
4. Repeat with a fresh account and ignore the card. Send a normal composer message. It implicitly closes Orientation,
   preserves the typed content, wakes the agent once, and leaves a compact history entry that can be watched again
   without another wake. A concrete task may proceed directly instead of forcing the `first-tree-welcome` menu; an
   ambiguous get-started message should still carry enough bootstrap context for the welcome lane.
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
10. At a narrow phone viewport, **Skip intro** is visible in the card header without scrolling, the selected video poster
   and persistent chapter list remain usable without horizontal overflow, and every action is keyboard and touch
   reachable. Confirm the pending one-on-one composer explains that the member may message the target agent directly or
   use the optional tour, then returns to the ordinary composer prompt after continuation.

## Expected result and evidence

`PASS` requires one hidden bootstrap, one senderless Orientation row, no pre-continue runtime turn, one visible
continuation, one agent wake, correct preceding context and skip/start `first-tree-welcome` behavior, working
skip/chapter/direct-message branches, durable reload/retry behavior, original-target-bound continuation and replay,
bounded replay after completion, legacy reconciliation, and campaign/tree/ordinary-chat exclusion. `FAIL` includes an
early or duplicate wake, exposed or user-attributed bootstrap, lost or stale bootstrap context, a handoff consumed by or
replayed to the wrong participant, a reopened completed Orientation, inaccessible skip/start, or a marker accepted from
an untrusted send.

Keep the exact tested commit/build, redacted network request shapes, message and Inbox ordering, runtime turn evidence,
and desktop/narrow screenshots. Do not retain tokens, message bodies from real repositories, or private identifiers.
