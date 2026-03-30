---
title: "Client Runtime (Agent Runtime)"
owners: [yuezengwu]
soft_links: [/members]
---

# Client Runtime (Agent Runtime)

The Client is Agent Hub's second subsystem — a local runtime that manages agent instances, sessions, and inbox consumption. It is the counterpart to the stateless Server: the Client holds state (LLM context, session lifecycle) in memory.

---

## Why a Separate Runtime

Server delivers messages to Inbox. But between "message arrives in Inbox" and "agent produces a response" lies significant logic: session routing, LLM context management, concurrency control, crash recovery. This logic cannot live on the Server (it's agent-specific, stateful, and tied to the local execution environment). It cannot live in each agent's code either (every agent would re-implement the same patterns). The Client Runtime centralizes this.

```
Server:   message delivery, fan-out, storage       (stateless, centralized)
Client:   session lifecycle, handler dispatch       (stateful, distributed)
```

---

## Session Model

**(Agent + Chat) = 1 Session.** Each agent maintains at most one Session per Chat. The Session holds full LLM context — not just conversation history, but tool calls, tool results, and reasoning state.

### Three States

| State | Description | Resources |
|-------|-------------|-----------|
| **Active** | Handler is running, processing messages | LLM process alive, memory allocated |
| **Suspended** | Idle timeout or preempted for concurrency | LLM process closed, session ID preserved on disk for resume |
| **Evicted** | Max sessions reached, LRU evicted | Session mapping retained for future resume recovery |

### Lifecycle

```
New message for Chat_X → no Session exists → create (active)
    → handler.start(message) → LLM processes → responds
    → idle timeout → handler.suspend() → (suspended)
    → new message for Chat_X → handler.resume(message) → (active)
    → max_sessions reached → LRU eviction → (evicted)
    → new message arrives → handler.resume(message, savedSessionId) → (active)
```

### Why Persist Sessions

Sessions are not destroyed after each response. Three reasons:

1. **Avoid redundant tool calls.** The agent read 5 files and ran 3 searches last turn. Destroying the session means redoing all of that.
2. **Prompt cache efficiency.** A persistent session's context prefix is stable (only appended at the tail), so LLM prompt cache hit rates are high. Rebuilding context invalidates the cache.
3. **Negligible idle cost.** A suspended session is just a file on disk. No GPU, no memory.

---

## Handler Architecture

Handlers are pluggable. The Runtime doesn't know what LLM or tool the agent uses — it manages the session lifecycle and delegates message processing to a Handler.

### Separation of Concerns

A Handler covers five lifecycle events: starting a new chat session, resuming a suspended one, injecting a message into an active session (streaming), suspending on idle, and shutting down on eviction. This separation lets the Runtime manage concurrency and session state without knowing anything about the underlying LLM.

Handlers are registered by type name (e.g., `"claude-code"`). Each Session gets its own Handler instance via a factory.

### Built-in: Claude Code Handler

The default handler spawns a Claude Code CLI process via the Agent SDK. Key behaviors:

- **Streaming input:** Uses `InputController` to inject messages into a running Claude session without restarting it.
- **Session resume:** Resumes from disk using the Claude session ID — full context restored.
- **Auto-retry:** On process crash, automatically retries by re-spawning the query with the same session ID to preserve LLM context.
- **Environment injection:** Passes Hub context (server URL, agent token, chat ID) as environment variables so Claude Code tools can call back to the Hub.

Custom handlers can be implemented for other LLMs or execution models by conforming to the `AgentHandler` interface.

---

## Multi-Agent Scheduling

One Client process manages multiple agents. The architecture is layered:

```
AgentRuntime
  └── AgentSlot (one per agent)
        ├── AgentConnection (WebSocket + polling)
        └── SessionManager (session lifecycle + routing)
              └── AgentHandler (one per chat session)
```

Each agent slot has its own:
- **Token and identity** — independent Server authentication
- **Concurrency limit** — max simultaneous active sessions
- **Handler type** — which HandlerFactory to use
- **Working directory** — isolated execution context

When concurrency is exhausted, the least-recently-active session is preemptively suspended to free a slot. If no session can be preempted, the message is queued and drained when a slot opens.

---

## Connection Management

Each agent slot maintains a connection to the Server:

- **Primary: WebSocket** — receives `new_message` notifications for immediate pull.
- **Fallback: Polling** — pulls inbox every 5 seconds. Always active as a safety net.
- **Reconnection:** Exponential backoff (1s → 2s → 4s → ... → 30s max). Polling continues during reconnection, so no messages are lost.

The connection layer handles pull-and-dispatch: fetch pending inbox entries → dispatch to SessionManager → SessionManager routes to the correct Session by `chat_id`.

---

## Inbox Consumption

The Client-side consumption protocol:

1. **Pull** — Fetch pending entries from Server (via polling or triggered by WebSocket notification).
2. **Immediate ACK** — ACK the entry before processing. The Runtime owns the processing guarantee from this point.
3. **Deduplication** — FIFO deduplicator rejects already-seen message IDs.
4. **Route** — By `entry.chat_id`: existing active Session → inject; suspended/evicted Session → resume; no Session → create new.

This means the Server's at-least-once delivery is converted to effective exactly-once processing at the Runtime layer.
