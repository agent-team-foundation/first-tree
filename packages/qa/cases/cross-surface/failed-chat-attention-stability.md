---
id: failed-chat-attention-stability
description: Validate that an errored managed-agent chat stays in Needs attention across disconnects and leaves only after recovery.
areas: [cross-surface]
surfaces: [client, server, web]
---

# Failed chat attention stability

## Goal

Confirm the real runtime-to-workspace path keeps a chat in `Needs attention`
while its caller-managed speaker remains errored, even if that agent disconnects
and its display status changes between failed and offline. The row should enter
the group once and leave once after genuine recovery, without repeatedly moving
between list groups.

The deterministic server test owns the projection rule. This case owns the live
Client session frames, presence changes, Web refetches, and visible conversation
rail behavior that the product test cannot prove.

## Preconditions

- Run the candidate server, Web, and Client in an isolated QA cell with a real
  PostgreSQL database and WebSocket connections.
- Sign in as the manager of a non-human agent and create a chat where that agent
  is a speaker.
- Keep browser network, WebSocket, and a short screen recording available. Do
  not use an unrelated peer's failed agent because Attention is manager-scoped.

## Operate and observe

- Trigger a real terminal turn or session failure. Confirm the chat moves once
  into `Needs attention`, its row exposes the failed marker, and the list
  response includes the agent in `failedAgentIds`.
- Disconnect the failed agent's Client without retrying or clearing the failed
  chat session. Observe long enough to cross multiple status frames and at
  least one conversation-list refetch.
- Reconnect the Client while leaving the same chat session errored. Repeat the
  observation window.
- Perform the supported recovery action and let the session become healthy.
  Confirm the chat leaves `Needs attention` once and returns to its normal
  recency or pinned location.

## Evidence

Keep the failure, disconnect, reconnect, and recovery timestamps; the relevant
WebSocket frames; the corresponding conversation-list responses; and a screen
recording of the rail. The evidence should show that reachability may change
the agent's display status to offline while `failedAgentIds` and the chat's
Attention membership remain stable until recovery.

## Expected result

`PASS` when the errored chat enters Attention once, stays there throughout
disconnect and reconnect, and leaves once only after recovery, with no repeated
row movement or visible list flashing.

`FAIL` when disconnecting or reconnecting an otherwise still-errored agent
removes and re-adds the chat, clears `failedAgentIds`, or repeatedly remounts the
row.

`BLOCKED` when the isolated runtime cannot produce and retain a real errored
session or the browser cannot observe the candidate WebSocket/list path.

`INCONCLUSIVE` when the recording or network/status evidence cannot attribute
the row movement to the candidate build.
