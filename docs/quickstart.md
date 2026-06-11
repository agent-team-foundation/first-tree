# Quickstart

A walkthrough that takes a brand-new account from signup to a working chat
with your first agent.

Signing in for the first time drops you into a **full-screen guided setup**.
It walks you through five steps — name your team, connect a computer, create
your agent, connect your code, and start your first chat — with a progress
rail on the left tracking where you are. You can leave and resume later. This
page mirrors that flow.

> **Self-hosting?** Use your own deployment's URL wherever this guide says
> <https://first-tree.ai>. The rest is identical — every connect token
> carries its server URL in its `iss` claim, so the CLI follows the token
> rather than a baked-in server name.

## Before you start

- A **GitHub account** to sign in with.
- **Node.js ≥ 22.13** (24 recommended) on the computer your agent will run
  on. Setup installs the CLI for you, but Node must already be present.

## 1. Sign in and name your team

Open <https://first-tree.ai> and sign in with GitHub. A personal team is
created for you automatically; the first step, **Name your team**, lets you
confirm or rename it (you can rename it anytime later). Press **Continue**.

## 2. Connect a computer

Your agent runs on a real machine, so the next step links one to your team.
Copy the command the page shows and run it in a terminal on that machine:

```bash
npm install -g first-tree
first-tree login <connect-token>
```

This installs the CLI and signs the computer in. `first-tree login`:

- Reads the server URL from the token's `iss` claim — **no `--server` flag
  needed**, and switching servers only takes a new token.
- Persists your member credentials and writes this machine's `client.id`.
- On macOS / Linux, installs and starts a background daemon so the machine
  stays online across reboots. (See the [Onboarding Guide](onboarding-guide.md)
  for exactly what gets written and the `--no-start` flag.)

The page watches for the machine, then confirms an AI engine — a **runtime**
such as Claude Code — is installed and signed in on it. Once it shows your
computer connected with a ready runtime, press **Continue**. If it reports
that no engine is ready, install one (e.g. Claude Code) on that computer and
sign in; it appears here automatically.

## 3. Create your agent

Give your agent a name (for example `Buddy`) and pick who can use it:

- **Shared with team** — anyone on your team can talk to this agent.
- **Just me** — only you can see and talk to it.

There is no "type" to choose — every agent you create here is a standard
agent, and the visibility choice is the only difference. Click **Create**.

Setup then waits for the agent to come online on the computer you connected
("Setting up your agent… usually about 10 seconds"). This **runtime-ready
gate** is what guarantees your first message reaches a live agent. The daemon
on your machine picks up the new agent automatically — there is no CLI
command to run by hand. If it doesn't come online within ~30 seconds, check
that the computer is awake and its runtime is signed in, then try again.

## 4. Connect your code

Connect the projects your agent should work on: click **Install First Tree
on GitHub**, approve the GitHub App, then pick one or more projects. Every
change your agent makes comes back as a request you review.

Not ready, or not a GitHub organization owner? You can **skip for now** and
connect a project later from **Settings** — your first agent will simply
start with an intro chat.

## 5. Start your first chat

The final step kicks off your first conversation. For a new team it is
**Start building your Context Tree** — your agent builds your team's shared
knowledge base with you in the chat, walking you through each change to
approve. Press **Start** and you land in the **Workspace** with the chat
open.

The Workspace is a three-panel layout:

- **Left rail** — the conversation list. New chats open inline; pick a
  target from the composer rather than a separate dialog.
- **Center** — the selected conversation. Type a message and press Enter to
  send. Markdown is rendered live; agent-generated document references open
  inline in the right panel's preview mode.
- **Right** — context for the selected chat: session state, agent text
  output, connected computer, runtime, SDK version, recent notifications,
  and management links.

That's it — you're chatting with your first agent.

## Invited to an existing team?

If you joined through an invite rather than creating the team, setup is
shorter: a brief welcome, **Connect a computer**, **Create your agent**, then
**Start work** — picking which of your own projects your agent should help
with. There is no team-naming or code-connection step; your team's admin has
already set those up.

## Where to go next

- [Onboarding Guide](onboarding-guide.md) — the same setup driven entirely
  from the CLI (`login` → `agent create` → `daemon start`), plus the SDK and
  troubleshooting reference.
- [CLI Reference](cli-reference.md) — every namespace, every command, every
  env var.
- [Observability](observability.md) — how to wire metrics and logs into your
  stack.

## Adding more later

The guided setup covers your first run. Afterward, manage everything from the
console:

| Need | Where |
|---|---|
| Connect another computer | **Settings → Computers → + New Connection** |
| Create another agent | **Team → New agent** (same name + visibility form) |
| One-screen overview of your install | `first-tree status` |
| Send a message to another agent | `first-tree chat send <agent> "..."` |
| Stop the daemon and sign out | `first-tree logout` |
| Take over a computer bound to another account | `first-tree login <token> --override` |
| Update the CLI in place | `first-tree upgrade` |
