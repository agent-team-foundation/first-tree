---
id: ws-client-auth-frame-enforcement
description: Verify the server client WebSocket endpoint performs a real WS upgrade and enforces the post-upgrade auth-frame protocol (timeout close for an unauthenticated connection).
areas: [cross-surface]
surfaces: [server, client]
---

# Client WebSocket Upgrade And Auth-Frame Enforcement

## Goal

Confirm that the server's client WebSocket endpoint (`/api/v1/agent/ws/client`) performs a **real WebSocket upgrade**
(HTTP 101) across the process boundary and then enforces its post-upgrade auth-frame protocol: an unauthenticated
connection that sends no auth frame is closed after the auth-frame timeout with a structured reason.

This exercises the real HTTP + WebSocket protocol boundary that `system/cloud/release/verification.md` marks as unguarded
by automated tests. It is the actual socket-framing layer — distinct from an HTTP `/healthz` reachability check.

**Scope caution — this case does NOT cover authenticated messaging.** It validates the WS upgrade and the auth-frame
*timeout / rejection* path only. Authenticated client registration, agent bind, and inbox message delivery need a valid
connect-token/login and belong to a separate case.

## Preconditions

- Isolated run cell with the server running (see `release-boot-health`).
- A WebSocket-capable client that can reach the server host over the run-cell network (e.g. a container on the same
  Docker network; Node's built-in global `WebSocket` works — no extra dependency needed).
- No credentials required: the case deliberately sends no auth frame and observes the server's enforcement.

## Operate

- `operate runtime-process`: open a WebSocket to `ws://<server>/api/v1/agent/ws/client`, send no auth frame, and keep the
  socket open past the auth-frame timeout (the shared constant `WS_AUTH_FRAME_TIMEOUT_MS`, currently 5s), logging the
  open, any server message, and the close event with its code and reason.

## Observe

- `observe runtime-event`: the socket reaches `open` — a real HTTP 101 WebSocket upgrade succeeded (not an HTTP request).
- `observe runtime-event`: after the auth-frame timeout the server pushes a structured auth message
  (`{"type":"auth:retryable","code":"auth_timeout", ...}`) and closes the connection. The close is a WebSocket close with
  a defined code (observed `1013`, "auth retryable") — the server actively enforces the protocol rather than leaving the
  socket open.

If the protocol constants or codes change during product work, follow the current typed schema in
`packages/shared` (`WS_AUTH_FRAME_TIMEOUT_MS`, the auth frame/close codes), but keep the evidence focused on the same
behavior: a real WS upgrade followed by server-side auth-frame enforcement.

## Expected Result

`PASS`: the endpoint completed a real WebSocket upgrade (101) and, with no auth frame sent, emitted a structured
auth-timeout message and closed the socket at approximately the auth-frame timeout with a defined close code.

`FAIL`: a reproducible product defect — the upgrade never completes against a healthy server, or an unauthenticated
connection is neither challenged nor closed (auth-frame enforcement missing).

`BLOCKED`: the server is not running, or no WebSocket-capable client can reach it in the run cell.

`INCONCLUSIVE`: the connection behavior was unstable, partial, or not attributable to the target ref.

## Evidence

Keep the timestamped connection log: the `open` (101 upgrade), the server auth message, and the close code + reason.
No secrets are involved because the case sends no credentials.
