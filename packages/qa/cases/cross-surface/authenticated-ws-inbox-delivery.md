---
id: authenticated-ws-inbox-delivery
description: Verify a message sent to a bound agent is delivered over the authenticated client WebSocket and starts an agent session (the cross-process product loop up to the model turn).
areas: [cross-surface]
surfaces: [server, client, cli]
---

# Authenticated WebSocket Inbox Delivery

## Goal

Verify the core cross-process product loop: an authenticated client daemon connects over WebSocket, an agent is bound to
it, and a message sent to that agent is **delivered over the WebSocket and starts an agent session** for the chat. This
is the real-time HTTP + WebSocket + inbox-delivery layer `system/cloud/release/verification.md` marks as unguarded by
automated tests.

**Scope caution — this case covers delivery + session start, not the model turn.** Completing an actual agent reply needs
provider `one-turn-ready` (a launchable, authenticated provider). Without a bridged provider credential the model turn
fails and the correct result is `BLOCKED` (per the package provider policy), NOT a product `FAIL`. Delivery is observable
before and independent of the turn.

## Preconditions

- Isolated run cell with the server running. To bootstrap a real login without external GitHub, run the server in a
  non-production mode with the dev auth bypass enabled (`NODE_ENV` != production and `FIRST_TREE_DEV_CALLBACK_ENABLED=1`),
  and set `FIRST_TREE_PUBLIC_URL` to a host the CLI run cell can reach (e.g. the compose service name) so connect URLs
  resolve inside the network.
- A built dist CLI in a container on the run-cell network.
- Auth bootstrap, all inside the run cell, no host credentials:
  1. dev-login (`GET /api/v1/auth/github/dev-callback?githubId=...&login=...`) → access token (an org is auto-created);
  2. `POST /api/v1/me/connect-tokens` (Bearer access) → connect URL;
  3. CLI `login <connect-url> --no-start` → client registered (clear any stale local config first);
  4. `daemon start --foreground --no-interactive` → client connects and registers over WebSocket.
- An agent bound to the client: `agent create <name> --type agent --runtime claude-code --client-id <clientId>` (note:
  `--type` is `human|agent`; the runtime is `--runtime`). The running daemon auto-binds it via a server push.

## Operate

- `operate http-api`: as the bootstrapped user (Bearer access), create a chat that targets the agent and carries a first
  message, e.g. `POST /api/v1/orgs/<orgId>/chats` with `{"mode":"task","initialRecipientNames":["<agent>"],
  "initialMessage":{"content":"..."}}`.
- `operate runtime-process`: keep the foreground daemon running so its WebSocket log records delivery.

## Observe

- `observe http-api`: the create-chat call returns `201` with a `chatId`, `messageId`, and the agent in
  `initialRecipientAgentIds`.
- `observe runtime-event`: the daemon's WebSocket log shows the message delivered — the agent slot logs `Session started`
  / `session created` for that `chatId` (the inbox delivery reached the client and started an agent session).
- `observe runtime-event` (provider gap): if no provider credential is bridged, the subsequent model turn fails
  (`Query error: … process exited`) and retries exhaust — this is the expected `one-turn-ready` gap, recorded as
  `BLOCKED` for the turn, not a product defect.

If wire frame names or fields change during product work, follow the current typed schema in `packages/shared`, but keep
the evidence focused on the same behavior: an authenticated WS connection carries an inbox delivery that starts an agent
session.

## Expected Result

`PASS` (delivery scope): the client authenticated and registered over WebSocket, an agent bound, and a message to that
agent was delivered over the WebSocket and started an agent session for the chat.

`FAIL`: a reproducible product defect — the authenticated WS never registers against a healthy server, an agent never
binds after creation, or a message to a bound agent is never delivered (no session start, no inbox frame).

`BLOCKED`: the run cell cannot bootstrap a login, or (for the model-turn extension) no provider is `one-turn-ready`.

`INCONCLUSIVE`: delivery behavior was partial, unstable, or not attributable to the target ref.

## Evidence

Keep the create-chat response, the daemon WS log lines showing session start for the chat, and (if reached) the
provider-turn failure that marks the `one-turn-ready` gap. Redact tokens and connect URLs before sharing.
