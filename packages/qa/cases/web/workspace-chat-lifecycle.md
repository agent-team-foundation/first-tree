---
id: workspace-chat-lifecycle
description: Validate that one workspace chat keeps its identity and task context while the user creates, pins, archives, finds, and restores it.
areas: [web]
surfaces: [web, server]
---

# Workspace chat lifecycle

## Goal

Confirm that a user can start one conversation in the real Web workspace and manage that same chat through its common
lifecycle without duplication or loss of task context. Deterministic product tests own the individual create, pin,
archive, filter, and unarchive transitions; this case owns their browser-visible composition against a real Server and
database.

## Preconditions

- Use an isolated disposable account and team with a usable agent already selected. Run a real Web, Server, and
  PostgreSQL stack; keep the product source unchanged during execution.
- Start with no archived chats and no pinned chats. Give the new task a unique, non-sensitive marker so the same chat
  can be identified after each transition.
- A real agent runtime is optional. If it is absent, do not claim that task delivery, agent execution, or replies were
  validated.

## Operate and observe

- Create a chat from New chat, send the uniquely marked task, and retain its URL or chat ID. Confirm the new chat opens
  once and the submitted task is visible.
- Pin that chat, archive it, and switch to the archived view. Confirm the active view no longer lists it and the
  archived view contains the same chat rather than a duplicate.
- Unarchive the chat, return to the active view, and confirm it remains pinned. Reopen and reload it; the original URL
  or chat ID and uniquely marked task must still identify the same conversation.
- Confirm the onboarding or kickoff chat remains distinct and no extra conversation was created by pinning,
  archiving, filtering, restoring, or reloading.

## Evidence

Keep the exact target ref, the disposable account identifier, the chat URL or ID, redacted create/pin/archive/unarchive
responses, and screenshots showing the chat before archive, in the archived view, and restored under Pinned. Never
retain tokens, cookies, or real user content.

## Expected result

`PASS` requires one chat identity to survive the complete lifecycle with its task context intact, its pin preserved,
and no duplicate chat. `FAIL` includes lost context, a changed identity, incorrect active/archived visibility, lost pin
state, or duplication. `BLOCKED` applies when an isolated real Web/Server/database path cannot be run.

A green browser-driver run covers only the exercised fresh-account happy path. It does not prove agent-runtime
delivery, concurrent or cross-device synchronization, tenancy isolation, schedule warnings, failure recovery, or
other unexercised branches.
