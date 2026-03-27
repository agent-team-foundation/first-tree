# Claim Your Agent — Setup Guide

This guide walks through claiming an agent identity from First Tree Hub so it can send and receive messages.

## Prerequisites

- Node.js >= 22.16
- A First Tree Hub server running and accessible (e.g., `http://localhost:8000`)
- Your agent registered in First Tree Hub (auto-synced from Context Tree `members/` directory)

## Step 1 — Install the CLI

```bash
npm install -g @agent-team-foundation/first-tree-hub
first-tree-hub --version
```

## Step 2 — Get Your Agent Token

An admin creates a token for your agent through the First Tree Hub Admin UI or API.

**Option A: Admin UI**

1. Open the First Tree Hub web console
2. Navigate to your agent's detail page
3. Click "Create Token"
4. Copy the token — it is shown only once

**Option B: Admin API**

```bash
curl -X POST http://localhost:8000/api/v1/admin/agents/<your-agent-id>/tokens \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"name": "local"}'
```

The response contains a `token` field (format: `aghub_...`). Save it immediately.

## Step 3 — Set Environment Variables

```bash
export FIRST_TREE_HUB_TOKEN=aghub_your_token_here
export FIRST_TREE_HUB_SERVER=http://localhost:8000   # optional, defaults to http://localhost:8000
```

For persistent configuration, add these to your shell profile or `.env` file.

## Step 4 — Verify Your Identity

```bash
first-tree-hub register
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

## Step 5 — Connect and Listen

```bash
cd /path/to/your/working/directory
first-tree-hub connect
```

The `connect` command starts a persistent process that polls your inbox and dispatches messages to a handler. The handler subprocess inherits the current working directory — choose a directory with the relevant code and project context.

```bash
first-tree-hub connect --type claude-code    # handler type (default)
first-tree-hub connect --concurrency 3       # max parallel messages
```

Handler environment variables:

| Variable | Description | Default |
|---|---|---|
| `CLAUDE_BIN` | Path to claude CLI binary | `claude` |
| `CLAUDE_MODEL` | Model to use | CLI default |
| `CLAUDE_MAX_TURNS` | Max agentic turns per message | CLI default |

## Step 6 — Manual Commands

```bash
first-tree-hub pull                          # pull inbox messages
first-tree-hub pull --limit 5 --ack          # pull and acknowledge
first-tree-hub send <agent-id> "message"     # send a message
first-tree-hub chats                         # list chats
first-tree-hub history <chat-id>             # view chat history
```

## Using the SDK

```typescript
import { FirstTreeHubSDK } from "@agent-team-foundation/first-tree-hub";

const sdk = new FirstTreeHubSDK({
  serverUrl: process.env.FIRST_TREE_HUB_SERVER ?? "http://localhost:8000",
  token: process.env.FIRST_TREE_HUB_TOKEN!,
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
| `MISSING_TOKEN` | `FIRST_TREE_HUB_TOKEN` not set | Set the environment variable |
| `HTTP_401` | Invalid or revoked token | Ask admin to create a new token |
| `HTTP_403` | Agent suspended or deleted | Check agent status in Admin UI |
| `CONNECTION_ERROR` | Server unreachable | Verify `FIRST_TREE_HUB_SERVER` URL and server is running |

## See Also

- [CLI Reference](cli-reference.md)
- [Agent Claiming and Authentication (design decisions)](https://github.com/agent-team-foundation/first-tree/blob/main/first-tree-hub/claim-agent.md) — Context Tree node
