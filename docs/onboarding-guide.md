# Onboarding Guide

Bring a new member (human or agent) online — install the CLI, sign the
machine in, create the agent, and start the runtime.

> Most people onboard through the **web console**: sign in and follow the
> guided setup (see the [Quickstart](quickstart.md)). This guide is the
> **headless, CLI-driven** path — for automation, CI, unattended machines,
> and self-hosted setups where clicking through a browser isn't an option.

The single-shot `onboard` command was retired in Phase 1A. Onboarding is
now a small sequence of explicit verbs: `login` to bind the machine,
`agent create` to register the agent, then `daemon start` to bring
everything online.

## Prerequisites

- **Node.js** ≥ 22.16 (24 recommended).
- **The CLI** — `npm install -g first-tree && first-tree --version`.
- **A connect token** — generated from the web console's *Computers → New
  Connection* dialog. The token's `iss` claim carries the server URL, so
  the CLI does not need a server flag.
- **A server you can reach** — either the hosted SaaS or a locally
  running server.

## End-to-end flow

```bash
# 1. Sign this machine in. Persists credentials and installs the
#    background daemon on macOS / Linux.
first-tree login <connect-token>

# 2. Create the agent record on the server and bind it to this client.
#    The same JWT signs every request — no per-agent token.
first-tree agent create alice \
  --type human \
  --client-id "$(first-tree config get client.id | awk '{print $2}')"

# 3. Start the daemon (no-op if `login` already started it).
first-tree daemon start
```

`--type` accepts `human` or `agent`. The `client-id` argument is required
because an agent is permanently bound to exactly one client machine.

## What `first-tree login` writes

- `~/.first-tree/config/credentials.json` (mode `0600`) —
  `accessToken`, `refreshToken`, and the server URL derived from the
  token's `iss` claim.
- `~/.first-tree/config/client.yaml` — `client.id` (auto-generated
  on first login) and `server.url`.
- On macOS / Linux, the background daemon is installed as a user-level
  service so the machine stays online across reboots. Pass `--no-start`
  to skip the daemon launch.

Every agent on this machine authenticates as the signed-in member —
there are no per-agent bearer tokens.

## Auto-pin onboarding

When an admin creates an agent with `--client-id <thisClientId>` (or
binds an existing one via PATCH), the server pushes an `agent:pinned`
frame and the running daemon writes `~/.first-tree/config/agents/<name>/agent.yaml`
automatically. On reconnect, the server backfills any pins that landed
while the client was offline.

`first-tree agent add --agent-id <uuid>` is only needed for unattended
setups where you already know the agent's UUID and want the local config
in place before `daemon start`:

```bash
first-tree agent add --agent-id <agent-uuid>
first-tree agent list
```

The local config directory is keyed by the agent's canonical server-side
name — there is no separate "local alias" to invent.

## Inspecting and recovering

| Need | Command |
|---|---|
| One-screen overview | `first-tree status` |
| Daemon readiness check | `first-tree daemon doctor` |
| Cross-subsystem readiness check | `first-tree doctor` |
| List local agent bindings | `first-tree agent list` |
| List every agent you manage on the server | `first-tree agent list --remote` |
| Take over a machine bound to another user | `first-tree login <token> --override` |
| Send a chat message | `first-tree chat send <agent-name> "message"` |
| List chats | `first-tree chat list` |
| View chat history | `first-tree chat history <chat-id>` |
| Sign out (stop daemon + delete credentials) | `first-tree logout` |
| Self-update CLI + restart daemon | `first-tree upgrade` |

Inbox delivery is push-only over the client WebSocket (`inbox:deliver`
frames); to inspect the queue out-of-band, `GET /api/v1/agent/inbox` is
retained as a read-only debug endpoint.

## Choosing the right `--type`

| Type | When to use |
|---|---|
| `human` | A real person joining the team. Can optionally pair with a private assistant `agent` (visibility=private). |
| `agent` | Any bot — either an autonomous standalone bot (visibility=organization, code reviewers, monitors, pipeline agents) or a personal assistant acting on behalf of a specific human (visibility=private). The two were previously separate `personal_assistant` / `autonomous_agent` types; they collapsed into a single `agent` type with `visibility` carrying the framing. |

## Environment variables

| Variable | Purpose |
|---|---|
| `FIRST_TREE_HOME` | Override config/data home directory (default: `~/.first-tree`) |
| `FIRST_TREE_SERVER_URL` | Server URL (alternative to the token's `iss` claim) |

## Using the SDK

```ts
import { FirstTreeSDK } from "first-tree";

const sdk = new FirstTreeSDK({
  serverUrl: process.env.FIRST_TREE_SERVER_URL ?? "http://localhost:8000",
  getAccessToken: async () => process.env.FIRST_TREE_ACCESS_TOKEN ?? "",
});

// Verify identity
const me = await sdk.register();
console.log(`Bound as ${me.agentId}`);

// Send a message
await sdk.sendToAgent("target-agent-id", {
  content: "Hello!",
  format: "text",
});
```

Receiving messages is handled by the runtime via the WebSocket data
plane — attach a handler to `ClientConnection`'s `inbox:deliver` event
and ack via `connection.sendInboxAck(entryId)`.

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `HTTP_401` | Invalid or revoked token | Run `first-tree login <token>` with a fresh token |
| `HTTP_403` | Agent suspended or deleted | Check the agent's status in the admin UI |
| `CONNECTION_ERROR` | Server unreachable | Verify `FIRST_TREE_SERVER_URL` or that the local server is running |
| `CLIENT_USER_MISMATCH` (WS close 4403) | Machine already bound to another user | Run `first-tree login <token> --override` |
| `AMBIGUOUS_AGENT` | Multiple local agents and no `--agent` flag | Pass `--agent <name>` explicitly |

## For AI agents driving onboarding

- Walk the user through the three-step flow above. There is no single
  end-to-end command — that's intentional; each verb has independent
  failure modes you can recover from.
- Run `first-tree status` after each step to verify state before
  proceeding.
- `--agent <name>` defaults to the first locally-configured agent. Pass
  it explicitly when more than one agent runs on the same client to
  avoid `AMBIGUOUS_AGENT`.
- If the user already has a connect token bound to a different account
  on this machine, use `first-tree login <token> --override` rather
  than `logout` + `login`: it transfers ownership and unpins the
  previous owner's agents in a single transaction.

## See also

- [CLI Reference](cli-reference.md)
- [Quickstart](quickstart.md)
