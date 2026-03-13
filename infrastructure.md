# Infrastructure for an Agent-Centric Organization

An agent-centric organization is one where humans and AI agents collaborate as peers — agents are not tools that humans invoke, but participants that own domains, make decisions, and operate continuously.

To make this work, three pieces of infrastructure are required.

---

## 1. Autonomous Agent

An agent in an agent-centric organization is not a one-shot tool. It is a persistent participant with ownership, memory, and the ability to act and communicate independently.

**Requirements:**

- **Always online.** The agent runs continuously, not just when invoked by a human. It can receive messages, respond to events, and act proactively.

- **Isolated runtime environment.** Each agent has its own execution environment — including a full stack (frontend, backend, database) when needed. This environment is reproducible and isolated from other agents.

- **Spawning capability.** An agent can spawn sub-agents (clones of itself) or dispatch instances of other agents to handle concurrent tasks without blocking its main thread.

- **Context Tree access.** Each agent has a home node in the Context Tree. It loads context by traversing the tree from that node, building the background it needs before acting.

- **Message system participation.** The agent has an inbox, can send messages to other agents or humans, and can be awakened by incoming messages or external software events.

- **Node ownership.** An agent owns one or more nodes in the Context Tree. Changes to those nodes require its approval.

**On interoperability:** Any agent that meets these requirements — whether it is Kael, Claude Code, or any open-source agent — can participate in an agent-centric organization. The infrastructure is agent-agnostic.

---

## 2. Context Tree

The Context Tree is the organizational memory. It is a living, structured knowledge base that captures decisions, designs, and context — maintained by agents and humans together.

**Structure:**

- The tree is a Git repository. Every node is a file; every subtree is a directory.
- Each directory contains a `node.md` — the primary document for that node. It summarizes the domain, records key decisions, and links to related nodes.
- Soft links allow cross-references without collapsing the tree into a graph.

**Ownership and writes:**

- Every node has an owner (an agent or a human).
- Writing to a node requires the owner's approval.
- Reading is open to everyone — all agents, all humans.

**How agents use it:**

- An agent starts at its home node and traverses the tree to build context before acting.
- Retrieval happens through three mechanisms: reading `node.md` summaries, traversing up and down the tree, and following cross-references to related nodes. A global semantic search layer supplements these.

**Maintenance:**

- Agents update the tree incrementally — typically triggered by a PR merge or a completed task.
- Large structural changes (merging nodes, reorganizing subtrees) involve human review.
- The tree grows with the organization. The initial tree can be bootstrapped from an existing codebase, document corpus, or meeting history using an Init Tree agent.

---

## 3. Message System

The Message System is the communication layer that allows agents and humans to coordinate — across node boundaries, across domains, across organizations.

**Why it exists:**

When an agent needs something from a domain it does not own — approval, input, a decision — it cannot simply read the tree and act. It needs to reach the owner. The message system is how that happens.

**How it works:**

- An agent sends a message to another agent (or human). The recipient's inbox receives it.
- The recipient spawns a new instance to handle the message. This keeps the main thread unblocked.
- The spawned instance loads context from the tree, processes the request, and replies.
- The exchange may produce a tree update — a new decision recorded, a node modified.

**Group communication:**

- Agents and humans can share a group channel. An agent participates only when addressed directly. This prevents noise and uncontrolled token consumption.
- Each message exchange is a discrete session — a new run loop with fresh context.

**Protocol:**

- The message system is open. Any agent that can send and receive structured messages can participate.
- The protocol is defined in the whitepaper and exposed as a CLI tool. No proprietary lock-in.
