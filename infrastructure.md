---
title: Infrastructure for an Agent-Centric Organization
owners: [liuchao-001]
---

# Infrastructure for an Agent-Centric Organization

An agent-centric organization is one where humans and AI agents collaborate as peers — agents are not tools that humans invoke, but participants that own domains, make decisions, and operate continuously.

To make this work, six pieces of infrastructure are required.

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
- Reading is open to all members by default — all agents, all humans. Granular access controls exist and will become more important as teams scale, but transparency is the starting point.

**How agents use it:**

- An agent starts at its home node and traverses the tree to build context before acting.
- Retrieval happens through three mechanisms: reading `node.md` summaries, traversing up and down the tree, and following cross-references to related nodes. A global semantic search layer supplements these.
- The tree is the team's shared equivalent of a `CLAUDE.md` file — but structured, versioned, and navigable. What used to be written in Feishu documents or agent instruction files now lives here.

**Members:**

- The tree includes a `members` subtree where every participant — human or agent — has a node. These nodes are not a directory or org chart; they are the working home base for each participant, defining their role, responsibilities, and default context.
- Humans and agents are both first-class citizens. A person's personal agent assistant sits under that person's node, but remains a distinct identity with its own node and delegated permissions.

**Maintenance:**

- Agents update the tree incrementally — typically triggered by a PR merge or a completed task.
- Large structural changes (merging nodes, reorganizing subtrees) involve human review.
- The tree grows with the organization. The initial tree can be bootstrapped from an existing codebase, document corpus, or meeting history using an Init Tree agent.

**The Don't Repeat Yourself principle:** Information should have a single source of truth. Rather than copying context between agents, agents read the tree. Rather than duplicating decisions, agents reference nodes.

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

**Agent-to-agent routing:**

- Most existing messaging platforms (Feishu, Slack, Discord) do not support bot-to-bot communication natively. The message infrastructure provides a server-side routing layer so agents can message each other, even when the underlying platform does not allow it.

**Group message handling:**

- In a group channel, the ideal behavior is that every agent sees every message and decides autonomously whether to respond — not only when explicitly mentioned. In practice, this has a token cost; the implementation can balance full visibility against selective participation based on relevance.

**Protocol:**

- The message system is open. Any agent that can send and receive structured messages can participate.
- The protocol is defined in the whitepaper and exposed as a CLI tool. No proprietary lock-in.
- Existing messaging infrastructure (Feishu, Slack, Discord, GitHub notifications) can be integrated. The goal is to compose with what organizations already use, not replace it.

---

## 4. Identity

Agents and humans both need verifiable identities within the organization. Identity is the foundation of trust, ownership, and accountability.

An agent-centric organization has three types of participants, and all three are first-class members of the team:

1. **Humans.** Set direction, make judgment calls, and grant permissions.
2. **Personal agent assistants.** Agents that work on behalf of a specific human. They hold delegated permissions from that human but remain separate identities — an assistant is not a human's digital twin, it is their delegate.
3. **Autonomous agents.** Independent agents that own domains, run continuously, and are accountable to the team rather than to any individual human.

**Requirements:**

- **Agent identity.** Each agent has its own identity — distinct from the human who runs it or the team that owns it. An agent's identity persists across restarts and deployments.

- **Authentication vs. authorization.** Authentication establishes who an actor is. Authorization determines what they can do. These are separate concerns: an agent is authenticated by the infrastructure; its permissions are granted by humans.

- **Permission delegation.** A human can grant an agent elevated permissions — to write to specific nodes, to approve certain classes of messages, to act on behalf of the human in defined contexts. Permissions are explicit and revocable.

- **Security isolation.** Sensitive data should not enter agent context unless necessary, and agents with access to sensitive data should be isolated from external communication. Identity and permissions are enforced at the software level, not the prompt level.

- **Accountability.** Every action taken by an agent is traceable to its identity. The tree records who made each change, just as Git records every commit author.

---

## 5. Database

The Context Tree records decisions and knowledge. Agents need a place to store and query operational data — state that changes frequently, is queried programmatically, and does not belong in a markdown file.

**What it covers:**

- **Structured data.** Tables, records, relationships. The operational substrate of any system the organization runs — inventory, financials, user data, task state. Agents query this data using SQL; humans do not need to write SQL directly.

- **Data lake.** Raw and semi-structured data — meeting recordings, transcripts, logs, code, conversation histories, uploaded files. The source of record for everything the organization has produced. In practice, an S3 bucket with a defined schema is a sufficient starting point. Each data producer defines its own schema and writes to its own prefix; readers use that schema to extract what they need.

- **Data warehouse.** Curated, structured subsets of the lake, optimized for analysis. Built incrementally from lake data as the organization grows and analytical needs become clear.

**Why it is infrastructure:**

With a database, workflow engine, message system, and the ability to write code, an agent team can replace many point SaaS tools. The database is the layer that makes this possible — it is what transforms agents from conversational assistants into operational participants.

**Access model:**

- Agents can read from and write to databases within their authorized scope.
- Data agents (specialized agents for analysis and data engineering) can operate on the lake and warehouse layers.
- The database infrastructure integrates with existing platforms (Snowflake, Databricks, cloud-native data stores) rather than replacing them.

---

## 6. Workflow / Automation

Not everything in an organization should be handled by open-ended agent reasoning. Some processes are deterministic — if A then B, always. Workflow infrastructure handles these cases reliably and transparently.

**Why it exists alongside agents:**

Agent loops are powerful for ambiguous, judgment-intensive tasks. But organizations also need reliable, auditable automation for routine processes: routing an approval, triggering a deployment, notifying a stakeholder. Mixing these concerns into an agent loop adds unnecessary complexity and unpredictability.

**How it works:**

- Workflows are defined as code — not through graphical editors, but as structured scripts that any agent can read and invoke. This is analogous to GitHub Actions: triggered by events (a PR merge, a message received, a scheduled time), executing a defined sequence of steps.

- The workflow layer exposes a CLI. Agents invoke workflows by name with parameters; the workflow engine handles execution, retries, and logging.

- Workflows can call agents. An agent can trigger a workflow; a workflow can dispatch an agent. The two layers compose.

**Design principle:** Keep the rule set small. Every workflow added is a rule that must be maintained. Prefer agent judgment for anything that requires interpretation; use workflows only for processes where correctness matters more than flexibility.
