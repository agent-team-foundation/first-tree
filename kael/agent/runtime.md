---
title: Runtime
owners: [yuezengwu]
soft_links: [/kael/chat, /kael/agent/context.md]
---

# Runtime

The agent runtime manages long-running task execution with recovery guarantees.

---

## Execution Model

Each user message triggers an agent task. Tasks run asynchronously and stream events (tool calls, text deltas, final result) to the frontend via SSE. The runtime tracks all active tasks and supports cancellation mid-execution.

---

## Recovery

On backend restart, the runtime detects orphaned tasks (agent_status = RUNNING with no active executor) and either resumes or marks them as failed. This ensures no user message is silently dropped.

---

## Message Queue

An in-memory per-session queue ensures messages are processed sequentially. If a message arrives while the agent is running, it's queued and processed after the current task completes.
