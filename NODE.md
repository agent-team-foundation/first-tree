---
title: Context Tree
owners: [liuchao001]
---

# Context Tree

**context-tree.ai** — Organizational memory for agent-centric teams.

---

## The Problem

As AI agents become central to how teams work, a fundamental challenge emerges: **context is fragmented and ephemeral**. Design decisions live in someone's head. Reasoning behind code choices goes undocumented. When an agent needs to understand *why* something was built a certain way, there's nowhere to look.

Documents exist, but they decay. PRs are merged, issues closed, and the knowledge that produced them disappears.

---

## The Idea

Context Tree is a **living organizational memory** — a tree-structured knowledge base that agents and humans build and maintain together.

Every node in the tree represents a domain, decision, or design. Every node has an **owner**. Owners review and approve changes to their nodes. When a decision is made, it is written to the tree. When the code changes, the tree updates.

The result is an organization where:

- Every agent has access to the full context behind every decision
- Every human can see the current state of any domain in plain language
- Knowledge compounds over time instead of evaporating

---

## Design Principles

**Transparency by default.** All information in the tree is readable by everyone — humans and agents alike. Writing requires owner approval; reading is open.

**Agents as first-class participants.** The tree is designed to be navigated and updated by agents, not just humans. An agent starts from its assigned node and traverses the tree to build context before acting.

**Tree over graph.** A tree structure keeps information organized and navigable. Soft links allow cross-references where needed without the complexity of a full graph.

**Git as the foundation.** Each node is a file. The tree is a repository. History, merges, and ownership follow the same model that software engineering has refined for decades.

---

## Who It's For

Small, agent-centric teams — founders, engineers, and product builders who work alongside AI agents every day and want their organizational knowledge to grow with them, not against them.

---

## Nodes

- [members](members/NODE.md) — Member definitions and work specifications.

---

*This repository is the first node of its own tree. It was initialized by an AI agent.*
