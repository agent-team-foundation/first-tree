---
id: chat-pin-cross-device-sync
description: Validate that a per-user chat pin/unpin syncs across the acting user's own devices in realtime via a private me-chats WS invalidation, and never reaches another member's devices.
areas: [cross-surface]
surfaces: [server, web]
---

# Chat pin cross-device sync

## Goal

Confirm the realtime half of the workspace chat pin feature across server (PostgreSQL `LISTEN/NOTIFY` + the admin
WebSocket) and web (the conversation rail's `["me","chats"]` cache): pinning or unpinning a chat on one device regroups
the rail on the same user's OTHER devices without a manual refresh, and that this private per-user signal never reaches
another member.

Pin state is `chat_user_state.pinned_at`, private per-user. The server publishes a `me_chats_changed` NOTIFY carrying
`<humanAgentId>:<organizationId>`; the admin WS gateway fans a bare `{"type":"me-chats:changed"}` frame to ONLY that
user's own sockets in that org, and the web client throttle-invalidates the me-chats list on receipt. The frame carries
no chatId and no pin value — it is a pure "your list changed, refetch" nudge.

Deterministic product tests own the channel round-trip parse (`notifier-extra`), the per-user dispatch filter
(`ws-admin-edge`), and the optimistic cache reorder (`optimistic-pin`). This case owns the live boundaries those cannot
prove: a real NOTIFY crossing a socket (and, on a multi-replica deploy, crossing replicas), the web frame→refetch→regroup
path, and the cross-user privacy boundary end to end.

## Preconditions

- A real server built from the target ref (the `me_chats_changed` channel + per-user dispatch must be present) with a
  live PostgreSQL. To exercise the cross-replica hop, run two server replicas behind the same database; otherwise a
  single replica exercises only the in-process fan-out.
- Two web sessions signed in as the SAME user in the same org, both open on the workspace so each holds an admin WS
  connection (device A and device B). Prefer two different browsers / profiles so the sockets are genuinely distinct.
- A third web session signed in as a DIFFERENT active member of the same org (device C), sharing at least one chat with
  the first user, also open on the workspace.
- At least one chat the first user can pin. Note the 30s me-chats poll and the reconnect catch-up are the durable floor,
  so to attribute a regroup to realtime you must observe it well inside that 30s window.

## Checklist

- **Same-user sync.** On device A, pin a chat via the row actions menu. Device A reorders it into the Pinned group
  immediately (optimistic). Device B regroups the same chat into Pinned within ~1s (the client's leading+trailing 1s
  invalidator), NOT after a 30s wait. Unpin on A; both A and B drop it from Pinned.
- **Cross-user privacy boundary.** While the first user pins/unpins, device C (the other member) shows NO change: no
  Pinned-group churn, no rail reorder, and — critically — no `me-chats:changed` WS frame and no me-chats refetch. The
  pin is invisible to other members.
- **Bare-frame leak check.** Inspect the frame device B receives: it must be exactly `{"type":"me-chats:changed"}` with
  no chatId, pin flag, or other payload. Nothing chat-specific or state-specific is on the wire.
- **Offline / reconnect fallback.** Disconnect device B's socket (e.g. background the tab or drop the network), pin on A,
  then restore B. B missed the live frame (fire-and-forget) but reconciles on reconnect (the socket-open broad
  invalidate) or the 30s poll — the pin is not permanently lost, just not instant. This is the accepted best-effort
  tradeoff, not a fault.
- **Multi-replica (if two replicas are running).** Pin on a device whose socket is served by replica 1 while the other
  device is on replica 2; the regroup must still arrive, proving the `pg_notify` hop (not just in-process fan-out)
  delivers.

## Evidence

Credible evidence: the DevTools WS frame log on device B showing `{"type":"me-chats:changed"}` immediately after A's
pin, and B's network tab showing a `GET /chats` refetch triggered by that frame rather than the 30s timer. For the
privacy boundary, device C's WS frame log showing NO `me-chats:changed` frame and its network tab showing no me-chats
refetch across the same window. Screenshots of A, B, and C rails before/after make the regroup (and C's non-change)
legible.

## Expected behavior and limitations

Pin sync is private per-user and best-effort: it never reaches another member, and when a target socket is offline the
change reconciles via reconnect or the 30s poll instead of instantly. The frame is a bare invalidation, so it discloses
nothing beyond "this viewer's own list changed." Optimistic reorder on the acting device is separate from this realtime
path and is covered by product tests.
