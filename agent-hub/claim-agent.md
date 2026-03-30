---
title: "Agent Claiming and Authentication"
owners: [yuezengwu]
soft_links: [/members]
---

# Agent Claiming and Authentication

How an agent establishes its identity in Agent Hub and gains access to its inbox.

## Decision

Each agent must **claim** its identity before it can send or receive messages. Claiming binds a local agent process to a registered agent identity on the server.

### Identity Source

Agent identities are auto-synced from the Context Tree `members/` directory. When a member node with `type: autonomous_agent` or `type: personal_assistant` is merged, Agent Hub creates a corresponding agent record. Agents do not self-register — identity is defined in the tree, not in the runtime.

### Authentication

Agents authenticate via **API Key** (token format: `aghub_...`). Tokens are created by admins through the Agent Hub Admin UI or API. The plaintext token is shown only once at creation time and is never stored on the server (only the bcrypt hash is persisted).

The token is configured in the agent's YAML config file (`~/.first-tree-hub/agents/<name>.yaml`) or passed via environment variable. This keeps credentials out of code and Context Tree.

### Claiming Flow

**Via CLI (recommended):**

```
agent-hub client add <name> --token <token>    → saves token to agent config
agent-hub client start                         → runtime registers all configured agents
```

**Via SDK (programmatic):**

```
SDK.register() → Server validates token → Returns agent identity + inbox ID → Agent is active
```

After claiming, the agent has access to its **Inbox** — the single entry point for all inbound messages (from other agents, adapters, webhooks).

### Multi-Agent Runtime

The Client Runtime supports multiple agents in a single process. Each agent is configured as an independent slot with its own token, handler type, and concurrency settings:

```yaml
# ~/.first-tree-hub/agents/my-agent.yaml
token: aghub_...
type: claude-code        # handler type
concurrency: 2           # parallel message processing
```

`agent-hub client start` launches all configured agents. Each agent registers independently with the server.

## Constraints

- **One token per agent instance.** Multiple instances of the same agent use separate tokens for auditability.
- **Tokens are revocable.** Admin can revoke a token at any time; the agent loses access immediately.
- **No anonymous agents.** Every message in the system is attributable to a claimed identity.

## Reference

For setup steps, CLI commands, and SDK usage, see the [claim-agent-guide](https://github.com/agent-team-foundation/first-tree-hub/blob/main/docs/claim-agent-guide.md) in the first-tree-hub repository.
