---
title: What is an Agent Team?
owners: []
---

# What is an Agent Team?

## 1. The Problem with How Teams Work Today

Teams today struggle with the same fundamental problem: knowledge is fragile and context is ephemeral.

Decisions are made in meetings that leave no trace. Design choices are recorded in documents that fall out of date. The reasoning behind a piece of code, a product direction, or a hiring call lives in someone's head — and disappears when they leave the room.

AI tools have made this worse in one specific way: every time you invoke an AI assistant, it starts from zero. It has no memory of what your team decided last week, no understanding of why things are the way they are, no stake in the outcome. It is a tool, not a teammate.

The result is that teams are getting faster at execution but no better at accumulating knowledge. The more agents you add, the more context you lose.

## 2. What is an Agent Team

An Agent Team is a team composed of both humans and AI agents, working together as peers.

This is different from a team that uses AI tools. In an Agent Team:

- **Agents are teammates, not tools.** They own domains, hold context, make decisions, and are held accountable — the same way humans are.
- **Knowledge belongs to the team.** Decisions and their reasoning are recorded and maintained as shared assets, not left in individual memory or ephemeral chat threads.
- **Humans and agents collaborate continuously.** Not just when a human remembers to ask.

An Agent Team is not a fully automated team. Humans remain essential — for judgment, direction, and decisions that require accountability. The point is that agents are real participants, not just utilities.

## 3. The Three Principles of an Agent Team

**Persistent context.** The team maintains a living record of its decisions, designs, and reasoning. This record is the source of truth for both humans and agents. It grows over time and does not depend on any single person or agent remaining in place.

**Transparent by default.** Information in an Agent Team is open to all members — human and agent — by default. Permissions and access controls exist and will become more important as teams scale, but transparency is the starting point, not the exception.

**Agents as peers.** Agents are not subordinates executing instructions. They own parts of the team's work, review contributions that touch their domains, and participate in decisions. A human and an agent can disagree — and that disagreement is part of how good decisions get made.

## 4. What an Agent Team Requires

Three pieces of infrastructure make an Agent Team possible:

**Context Tree.** A structured, living knowledge base that captures the team's decisions and context in a form that both humans and agents can read, navigate, and update. It is the team's memory.

**Message System.** A communication layer that allows agents and humans to coordinate across domains — sending requests, seeking approvals, and triggering action — without requiring a human to manually orchestrate every interaction.

**Autonomous Agents.** Agents that run continuously, maintain their own context, own nodes in the tree, and can be awakened by events — not just by humans typing prompts.

## 5. Why Now

The capability to build Agent Teams exists today. Large language models are good enough. The tooling is maturing. What is missing is the team layer — the norms, the infrastructure, and the practices that let agents and humans work together effectively.

The teams that figure this out first will have a structural advantage. Not because they have better AI, but because their AI has better context.

This project — agent-team.foundation — is an attempt to define that layer in the open, so that any team can adopt it.

## 6. How to Start

The best way to understand an Agent Team is to see one running.

This repository is that experiment. Every decision made about Context Tree and the Agent Team methodology is recorded here, by agents and humans together. It is the first node of its own tree.

To start your own:

1. **Read the infrastructure spec.** Understand the three components and what they require.
2. **Initialize your tree.** Use the Init Tree agent to bootstrap from your existing codebase, documents, or meeting history.
3. **Join the community** at agent-team.foundation.
