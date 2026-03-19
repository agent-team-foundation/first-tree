---
title: Browser Control
owners: [286ljb]
---

# Browser Control

The agent controls Chrome through a Manifest V3 browser extension connected to the backend via WebSocket.

---

## Capabilities

The agent can: navigate to URLs, read page content, find elements by natural language query, click, type, scroll, drag, hover, take screenshots, and manage tabs.

Actions are dispatched through two mechanisms:
- **Chrome Debugger Protocol (CDP)** for clicks, typing, and keyboard input — because many JavaScript frameworks (React, Angular) reject synthetic events. CDP produces `isTrusted` events that frameworks accept. The debugger attaches lazily and detaches after 60s idle.
- **Content script DOM APIs** for scrolling and element resolution — these don't have the same trust requirement.

---

## Element Finding

The agent finds elements via a heuristic matcher in the content script. It tokenizes a natural language query ("search bar", "login button"), scores all DOM elements by text match, ARIA attributes, and semantic tags, and returns up to 20 candidates with ref IDs and bounding rectangles.

Ref IDs are ephemeral handles that map to DOM elements via a WeakRef store. They decouple the agent's reasoning from DOM mutations — the agent refers to `ref_5`, not a CSS selector that might break on re-render.

An accessibility tree builder walks the DOM (max 500 nodes, 15 levels deep) to provide the agent with a structured page representation for LLM consumption.

---

## Tab Isolation

Agent-controlled tabs live in a dedicated "Kael" tab group (blue). This prevents the agent from interacting with the user's personal browsing tabs and makes agent activity visually distinct.

---

## Safety

Browser safety has two layers (enforcement of policies defined in platform/):

**Hard rules** — deterministic checks on URLs and domains. Curated lists of banking domains, payment URLs, email providers, and OAuth endpoints that always trigger user confirmation. The lists are intentionally small and focused on highest-risk providers.

**LLM self-assessment** — the agent provides a sensitivity classification (category + confidence) for each state-modifying action. Hard-confirm categories (FINANCIAL, DESTRUCTIVE, EXTERNAL_COMM, AUTHENTICATION) always require approval. Low confidence (<0.8) triggers confirmation as a safety net.

Read-only actions (screenshot, scroll, hover, find) skip safety checks entirely.

> **Note:** There is a `trust_domain` feature in the code (backend safety.py, extension confirm flow) that allows users to skip domain-based hard rules for the rest of a session after approving an action. This may have been superseded by the Resource Access Control system. Needs investigation and cleanup.

soft_links: [/kael/platform]

---

## Visual Feedback

The extension shows two overlays (Shadow DOM isolated from page styles):
- **Signal pill** (bottom center) — shows agent state: Thinking (blue pulse), Acting (green pulse), Idle (gray). Includes a stop button. Collapses after inactivity.
- **Cursor overlay** — animates cursor movement to action targets during clicks and drags, helping the user follow what the agent is doing.

---

## User Action Detection

During agent operation, the content script monitors for user clicks and input. If the user interacts with the page while the agent is thinking, the action is reported to the backend so the agent can re-evaluate (e.g., take a fresh screenshot). Agent's own actions are excluded by coordinate proximity filtering.
