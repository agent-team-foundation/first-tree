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

- **The CLI**. Prefer the portable command shown in the web console's
  *Computers → New Connection* dialog; it bundles Node.js. For headless
  production installs, the portable installer has this shape:
  `curl -fsSL https://downloads.first-tree.ai/prod/install.sh | sh`.
- **Node.js** ≥ 22.13 only when you choose the npm fallback path
  (`npm install -g first-tree`).
- **A connect token** — generated from the web console's *Computers → New
  Connection* dialog. New tokens are short URLs whose origin carries the
  server URL; legacy JWT tokens with an `iss` claim remain accepted during
  rollout. The CLI does not need a server flag.
- **A server you can reach** — either the hosted SaaS or a locally
  running server.

## End-to-end flow

```bash
FT_BIN=<binName> # first-tree, first-tree-staging, or first-tree-dev

# 1. Sign this machine in. Persists credentials and installs the
#    background daemon on macOS / Linux.
$FT_BIN login <connect-token>

# 2. Create the agent record on the server and bind it to this client.
#    The same JWT signs every request — no per-agent token.
$FT_BIN agent create alice \
  --type human \
  --client-id "$($FT_BIN config get client.id | awk '{print $2}')"

# 3. Start the daemon (no-op if `login` already started it).
$FT_BIN daemon start
```

`--type` accepts `human` or `agent`. The `client-id` argument is required
because an agent is permanently bound to exactly one client machine.

## What `first-tree login` writes

- `$FIRST_TREE_HOME/config/credentials.json` (mode `0600`) —
  `accessToken`, `refreshToken`, and the server URL derived from the
  connect token. New tokens are short URLs; legacy JWT tokens are still
  accepted during rollout.
- `$FIRST_TREE_HOME/config/client.yaml` — `client.id` (auto-generated
  on first login) and `server.url`.
- On macOS / Linux, the background daemon is installed as a user-level
  service so the machine stays online across reboots. Pass `--no-start`
  to skip the daemon launch.

Every agent on this machine authenticates as the signed-in member —
there are no per-agent bearer tokens.

## Auto-pin onboarding

When an admin creates an agent with `--client-id <thisClientId>` (or
binds an existing one via PATCH), the server pushes an `agent:pinned`
frame and the running daemon writes `$FIRST_TREE_HOME/config/agents/<name>/agent.yaml`
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
| Switch a machine to another user | `first-tree login <token>` with the new user's token, then confirm the switch |
| Destructively reset damaged local client state | `first-tree computer reset` |
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
| `FIRST_TREE_HOME` | Override config/data home directory. By default this is channel-dependent: `~/.first-tree` for prod, `~/.first-tree-staging` for staging, `~/.first-tree-dev` for dev. |
| `FIRST_TREE_SERVER_URL` | Server URL for SDK and non-login commands; `login` derives it from the connect token. |

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
| `CLIENT_USER_MISMATCH` (WS close 4403) | Active client id is not accepted for the current credentials | Back up local workspaces, run `first-tree computer reset`, then run `first-tree login <token>` with the intended account |
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
- If the user already has local First Tree state for a different account
  on this machine, run `first-tree login <token>` with the new user's
  connect token. Interactive terminals prompt for confirmation; non-TTY
  automation must pass `--force-switch`. That flag only confirms the switch:
  First Tree still stops and drains the old runtime, verifies switch gates,
  parks inactive local client state, and refuses to move root state if any
  safety gate fails.
- Use `first-tree computer reset` only when local identity state is damaged
  or the user intentionally wants to discard active and parked local
  client/agent state in this installation. It is a destructive local reset;
  server-side clients, agents, chats, and history are not deleted.

## See also

- [CLI Reference](cli-reference.md)
- [Quickstart](quickstart.md)
- [Onboarding kickoff contract](development/onboarding-kickoff-contract.md)
