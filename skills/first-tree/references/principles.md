---
title: "Tree Principles: Explanation and Examples"
owners: []
---

# Tree Principles

This document explains the four core principles of Context Tree and how to
apply them in practice. Read them in order: principle 1 defines what the tree
is for, principle 2 explains how to organize it, principle 3 clarifies access
and ownership, and principle 4 explains why the structure is tree-shaped and
Git-native.

---

## 1. Source of truth for decisions, not execution

The tree captures the *what* and *why* - strategic choices, cross-domain
relationships, and constraints. An agent should be able to read the tree and
decide on the right approach before consulting source systems for
implementation details.

### The decision test

If an agent needs this information to *decide* on an approach, it belongs in
the tree. If the agent only needs it to *execute*, it stays in the source
system.

### What belongs in the tree

- "Auth flows span four repos: backend issues JWTs, frontend uses Better Auth, browser extension authenticates via OAuth popup through the frontend, desktop app uses a localhost callback server."
- "We chose MinerU for PDF parsing because it handles academic papers with complex layouts better than alternatives we tested."
- "We target academic researchers and AI-native teams because they have the highest tolerance for an agent-centric workflow."
- "Q3 campaign focuses on developer communities because enterprise sales cycle is too long for our current stage."

### What does not belong in the tree

- The function signature of `retrieval_service.search()` - read the code.
- The database schema for the `chunk_embeddings` table - read the models.
- The current ad copy for a campaign - read the campaign tool.
- The current list of API endpoints - read the route files.
- The exact interview questions for a role - read the hiring doc.

### Good node examples

**Cross-domain relationships:** "Auth touches 4 repos: backend (JWT issuance), frontend (Better Auth client), browser extension (OAuth popup + device token), desktop (localhost callback server + JWT storage)." - An agent would need to search across all repos to piece this together.

**Strategic decisions with rationale:** "We use Reciprocal Rank Fusion to combine vector and BM25 results because pure vector search missed keyword-heavy queries and pure BM25 missed semantic matches." - This is nowhere in the source systems.

**Domain state summaries:** "The ingestion pipeline has 6 stages: download -> extract -> parse -> chunk -> embed -> store. PDF extraction uses MinerU (cloud). PPTX uses python-pptx locally." - An agent could trace this through 6+ files, or read one node.

### Bad node examples

- Restating what one source file already says clearly.
- Documenting stable, well-known patterns (e.g., "we use FastAPI for the backend").
- Listing things that change frequently without decision implications.

### Use judgment, not a checklist

Not every task needs a tree update. A pure UI bug fix probably does not. But
do not assume - a "simple" feature like dark mode becomes a tree-worthy
decision once it involves auto mode, cross-device persistence, or desktop app
coordination. Evaluate each task in context.

### How this works during a task

1. Human says: "Let's add SSO to our product."
2. Agent reads relevant tree nodes (e.g., `platform/`, `environment/`).
3. Agent writes a top-level design based on tree context alone.
4. Human reviews and approves.
5. Agent explores source systems to build a detailed execution plan.
6. If source systems reveal something the tree did not capture, update the
   tree, revisit with the human, then proceed.
7. After execution is complete, update the tree to reflect any new decisions.

This applies to all tasks - features, campaigns, hiring decisions, refactors.
Not every task requires a tree update, but the tree is always the starting
point, and the question "does the tree need updating?" is always asked at the
end.

### When the tree and source systems disagree

If an agent reads the tree, makes a decision, then discovers a source system
contradicts the tree, that is a tree bug. The tree must be corrected before
proceeding. This is how the tree stays accurate: every completed task is an
opportunity to validate and update it.

---

## 2. Agents are first-class participants

The tree is designed to be navigated and updated by agents, not just humans.
Domains are organized by concern - what an agent needs to know to act - not by
repo, team, or org chart.

### Organize by concern

An agent working on "add SSO support" does not think in terms of repos
(backend, frontend, extension, desktop) or org structure (engineering vs.
product). It needs all auth context - the why, the how, and the cross-domain
implications - in one place. Organizing by concern puts that context together.

### Place work in the domain of the primary concern

A feature or decision lives in the domain that owns the primary concern, with
soft links to other domains for discoverability:

- "Add SSO support" -> `platform/` (auth decision), soft links to
  `environment/` (extension/desktop auth flows)
- "Support PPTX parsing" -> `knowledge/` (ingestion). Clear, single domain.
- "Q3 developer campaign" -> `marketing/` (go-to-market), soft link to the
  product domain (feature positioning)
- "Agent remembers user preferences" -> `agent/` (memory)
- "Hire a frontend engineer" -> `people/hiring/` (role decision), soft link to
  the team they would join

### Start flat, then split when needed

Start flat. Split when an agent cannot scan a `NODE.md` and quickly determine
where to go next. If a domain accumulates enough leaf nodes on a single topic,
that topic is ready to become a subdomain.

---

## 3. Transparency by default

All information in the tree is readable by everyone - humans and agents alike.
Reading is open; writing requires owner approval.

This means any agent can build full context by traversing the tree. No domain
is hidden. The ownership model controls who can *change* the tree, not who can
*read* it.

---

## 4. Git-native tree structure

Each node is a file, each domain is a directory, and the tree itself is a Git
repository. The tree shape gives predictable navigation; Git provides history,
review, and ownership workflows.

### Why a tree

A tree structure keeps information organized and navigable. Soft links allow
cross-references where needed without the complexity of a full graph. An agent
can start at any node and traverse up (broader context) or down (more detail)
predictably.

### Why Git

History, ownership, and review follow the same model software engineering has
refined for decades. Every change is a commit, every decision is reviewable in
a PR, and the full history of how the tree evolved is preserved.
