---
title: Streaming
owners: [yuezengwu]
---

# Streaming

Chat uses a **split-channel design**: REST for sending messages, SSE for receiving events. This separation exists because SSE connections are long-lived (potentially hours), while message sends are short-lived — combining them in one channel created reconnection and ordering problems.

```
User sends message → POST /sessions/messages → Backend enqueues → Returns message_id + session_id
                                                                          ↓
SSE subscription ← POST /chat (long-lived) ← Events: user_message, agent_started, tool_call, text_delta, final_result
```

**Why not WebSocket?** SSE is simpler (HTTP/1.1, no upgrade), works through all proxies/CDNs, and the communication pattern is inherently unidirectional — the agent streams to the user, the user sends discrete messages. WebSocket's bidirectionality adds complexity without benefit here.

---

## Pending Messages

Messages go through a pending state between send and acknowledgment:

1. User sends message → frontend assigns a temporary UUID, shows "Sending..." in input area
2. Backend receives message → returns `message_id` + `session_id`, message is "Queued"
3. SSE emits `user_message` event → frontend removes pending message, adds to chat history

This pattern lets the user keep typing and sending while the agent is still processing. If the SSE connection drops, pending messages are tracked by UUID and reconciled on reconnection.

---

## Event Types

| Event | Purpose |
|-------|---------|
| `session_created` | New session started |
| `agent_started` | Agent began processing |
| `pending_messages` | Sync pending message state on reconnect |
| `user_message` | User message persisted and acknowledged |
| `tool_call` | Agent invoked a tool (name, args, result) |
| `text_delta` | Incremental text streaming |
| `final_result` | Agent finished, full response available |
| `agent_status` | Agent status changed (RUNNING → COMPLETED) |
| `heartbeat` | Keep-alive during idle periods (15-30s) |
| `error` | Error during processing |

Each event carries a sequence number (`seq`). On reconnect, the client sends `from_seq` to resume from where it left off — the backend replays missed events from an in-memory buffer (1000 events).
