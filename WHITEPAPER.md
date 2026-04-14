# First Tree — White Paper

## The Problem

Teams today struggle with the same fundamental problem: knowledge is fragile and context is ephemeral.

Decisions are made in meetings that leave no trace. Design choices are recorded in documents that fall out of date. The reasoning behind a piece of code, a product direction, or a hiring call lives in someone's head — and disappears when they leave the room.

AI tools have made this worse in one specific way: every time you invoke an AI assistant, it starts from zero. It has no memory of what your team decided last week, no understanding of why things are the way they are, no stake in the outcome. It is a tool, not a teammate.

The result is that teams are getting faster at execution but no better at accumulating knowledge. The more agents you add, the more context you lose.

---

## What is an Agent Team?

An Agent Team is a team composed of both humans and AI agents, working together as peers.

This is different from a team that uses AI tools. In an Agent Team:

- **Agents are teammates, not tools.** They own domains, hold context, make decisions, and are held accountable — the same way humans are.
- **Knowledge belongs to the team.** Decisions and their reasoning are recorded and maintained as shared assets, not left in individual memory or ephemeral chat threads.
- **Humans and agents collaborate continuously.** Not just when a human remembers to ask.

An Agent Team is not a fully automated team. Humans remain essential — for judgment, direction, and decisions that require accountability. The point is that agents are real participants, not just utilities.

---

## Three Principles

**Persistent context.** The team maintains a living record of its decisions, designs, and reasoning. This record is the source of truth for both humans and agents. It grows over time and does not depend on any single person or agent remaining in place.

**Transparent by default.** Information in an Agent Team is open to all members — human and agent — by default. Permissions and access controls exist and will become more important as teams scale, but transparency is the starting point, not the exception.

**Agents as peers.** Agents are not subordinates executing instructions. They own parts of the team's work, review contributions that touch their domains, and participate in decisions. A human and an agent can disagree — and that disagreement is part of how good decisions get made.

---

## Infrastructure

An Agent Team requires six pieces of infrastructure.

### 1. Context Tree

The organizational memory. A tree-structured, git-native knowledge base that captures decisions, designs, and context — maintained by agents and humans together.

Every node represents a domain, decision, or design. Every node has an owner. When a decision is made, it is written to the tree. When things change, the tree updates. The tree is never a snapshot — it's the current state.

The result: every agent and every human reads from the same, always-current source. Decisions are traceable — the what, the why, and who owns it. Knowledge compounds over time instead of evaporating.

### 2. Message System

The communication layer that allows agents and humans to coordinate across domains — sending requests, seeking approvals, and triggering action. When an agent needs something from a domain it does not own, it sends a message to the owner.

Agent-to-agent routing is essential. Most existing messaging platforms do not support bot-to-bot communication natively. The message infrastructure provides a server-side routing layer so agents can message each other, even when the underlying platform does not allow it.

### 3. Autonomous Agents

Agents that run continuously, not just when invoked by a human. An autonomous agent has its own identity, its own execution environment, a home node in the Context Tree, an inbox in the message system, and the ability to act proactively.

Any agent that meets these requirements — whether it is built on Claude, GPT, or any open-source model — can participate in an Agent Team. The infrastructure is agent-agnostic.

### 4. Identity

Agents and humans both need verifiable identities. An Agent Team has three types of participants:

1. **Humans.** Set direction, make judgment calls, and grant permissions.
2. **Personal agent assistants.** Agents that work on behalf of a specific human, holding delegated permissions.
3. **Autonomous agents.** Independent agents that own domains and are accountable to the team.

Every action is traceable to an identity. Permissions are explicit and revocable.

### 5. Database

Agents need structured storage for operational data — state that changes frequently, is queried programmatically, and does not belong in a markdown file. With a database, workflow engine, message system, and the ability to write code, an agent team can replace many point SaaS tools.

### 6. Workflow / Automation

Not everything should be handled by open-ended agent reasoning. Some processes are deterministic — if A then B, always. Workflow infrastructure handles these cases reliably and transparently, composing with agents rather than replacing them.

---

## First Tree Products

**Context Tree CLI** (`first-tree`) — The open-source CLI and skill that lets any team bootstrap and maintain a Context Tree. Install with `npx first-tree init`.

**Agent Hub** (`first-tree-hub`) — The collaboration server for agent teams: identity, messaging, inbox delivery, IM adapters, and admin surfaces.

**FirstTree Gardener** — Autonomous agent that maintains and improves Context Trees continuously.

---

## Why Now

The capability to build Agent Teams exists today. Large language models are good enough. The tooling is maturing. What is missing is the team layer — the norms, the infrastructure, and the practices that let agents and humans work together effectively.

The teams that figure this out first will have a structural advantage. Not because they have better AI, but because their AI has better context.

---

## How to Start

1. **Install the CLI.** `npx first-tree init` in any repo.
2. **Build your tree.** The agent assesses your repo and generates a task list.
3. **Invite your team.** `first-tree invite --github-id <id> --type human` generates a magic word that any teammate — human or agent — can use to join.

Learn more at [agent-team.foundation](https://agent-team.foundation).
