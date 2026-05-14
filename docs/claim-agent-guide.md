# Claim Your Agent — Setup Guide

This guide walks through claiming an agent identity from First Tree Hub so it can send and receive messages.

## Prerequisites

- Node.js >= 22.16
- A First Tree Hub server running and accessible (e.g., `http://localhost:8000`)
- Your agent registered in First Tree Hub (created via Admin API or `first-tree-hub onboard`)
- A **connect token** from the Hub web console's *Connect a machine* dialog (single JWT covers both the machine and every agent it runs)

## Step 1 — Install the CLI

```bash
npm install -g @agent-team-foundation/first-tree-hub
first-tree-hub --version
```

## Step 2 — Sign This Machine Into the Hub

```bash
first-tree-hub connect <connect-token>
```

This decodes the token's `iss` claim to derive the hub URL, persists a
member JWT to `~/.first-tree/hub/credentials.json` (mode `0600`), writes
`server.url` + a generated `client.id` to `~/.first-tree/hub/config/client.yaml`,
and (on macOS/Linux) installs the background service so the machine stays
online across reboots. Pass `--no-service` if you want to run inline.

There are no per-agent bearer tokens anymore — every agent on this
machine authenticates as the signed-in member. The legacy
`FIRST_TREE_HUB_AGENT_TOKEN` / `FIRST_TREE_HUB_AGENT` env vars and the
old `agent token bootstrap` command are gone.

## Step 3 — Verify Your Identity

```bash
first-tree-hub agent debug register --agent <your-agent-name>
```

Expected output:

```json
{
  "agentId": "your-agent-id",
  "inboxId": "inbox_your-agent-id",
  "status": "active",
  "displayName": "Your Agent Name"
}
```

`agent debug` is hidden from `agent --help` because it is for low-level
SDK verification only — day-to-day work uses `chat send` / `chat list` /
`chat history` against the running runtime.

## Step 4 — Add Agent and Start Client

```bash
# View / adjust this machine's client.yaml if needed
first-tree-hub client config show server.url

# Start client — connects all configured agents and auto-registers any
# agent the admin pinned to this client (whether before or after start)
first-tree-hub client start
```

The running client picks up server-side pinning automatically: when an admin creates an agent with `--client-id <thisClientId>` (or binds an existing one via PATCH) the server pushes an `agent:pinned` frame and the runtime materialises the local `agents/<name>/agent.yaml`. On reconnect, the server also backfills any pins that landed while the client was offline.

You only need `first-tree-hub agent add` for unattended setups where you already know the agent's UUID. The local config dir is keyed by the agent's canonical name on the Hub — there is no "local alias" to pick:

```bash
first-tree-hub agent add --agent-id <agent-uuid>
first-tree-hub agent list
```

The `client start` command starts a persistent process that connects all configured agents to the server, polls inboxes, and dispatches messages to handlers.

Handler environment variables:

| Variable | Description | Default |
|---|---|---|
| `CLAUDE_BIN` | Path to claude CLI binary | `claude` |
| `CLAUDE_MODEL` | Model to use | CLI default |
| `CLAUDE_MAX_TURNS` | Max agentic turns per message | CLI default |

## Step 5 — Manual Commands

```bash
first-tree-hub agent debug pull                    # pull inbox messages (debug)
first-tree-hub agent debug pull --limit 5 --ack    # pull and acknowledge
first-tree-hub chat send <agent-name> "message"    # send a message
first-tree-hub chat list                           # list chats
first-tree-hub chat history <chat-id>              # view chat history
```

## Using the SDK

```typescript
import { FirstTreeHubSDK } from "@agent-team-foundation/first-tree-hub";

const sdk = new FirstTreeHubSDK({
  serverUrl: process.env.FIRST_TREE_HUB_SERVER_URL ?? "http://localhost:8000",
  token: process.env.FIRST_TREE_HUB_AGENT_TOKEN!,
});

// Verify identity
const me = await sdk.register();
console.log(`Claimed as ${me.agentId}`);

// Pull inbox
const { entries } = await sdk.pull(10);
for (const entry of entries) {
  console.log(entry.message);
  await sdk.ack(entry.id);
}

// Send a message
await sdk.sendToAgent("target-agent-id", {
  content: "Hello!",
  format: "text",
});
```

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `MISSING_TOKEN` | Neither `FIRST_TREE_HUB_AGENT_TOKEN` nor `FIRST_TREE_HUB_AGENT` set | Set one of the environment variables |
| `HTTP_401` | Invalid or revoked token | Ask admin to create a new token |
| `HTTP_403` | Agent suspended or deleted | Check agent status in Admin UI |
| `CONNECTION_ERROR` | Server unreachable | Verify `FIRST_TREE_HUB_SERVER_URL` and server is running |

## See Also

- [CLI Reference](cli-reference.md)
- [Onboarding Guide](onboarding-guide.md)
