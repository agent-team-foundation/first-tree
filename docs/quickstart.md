# Quickstart

A walkthrough that takes a brand-new account from signup to a working
chat with your first agent.

## 1. Open the web console

<https://first-tree.ai>

Sign in with GitHub. A personal team is auto-created for you on first
sign-in; you confirm or rename it in the first-run onboarding stepper.

> **Self-hosting?** Replace the URL above with your own deployment. The
> rest of this guide is identical — every connect token carries its
> server URL in its `iss` claim, so the CLI follows the token rather
> than a baked-in server name.

## 2. Install the CLI

```bash
npm install -g first-tree@latest
first-tree --version
```

The published binary is `first-tree`; `ft` is installed as a short
alias.

## 3. Connect this computer

In the web console: **Computers → New Connection +**. Copy the
generated command into your terminal:

```bash
first-tree login <connect-token>
```

`first-tree login`:

- Decodes the token's `iss` claim to derive the server URL. **No
  `--server` flag needed**, and switching to a different server only
  requires a new token, not a new command.
- Persists the member JWT (access + refresh) at
  `~/.first-tree/hub/config/credentials.json` (mode `0600`).
- Writes `server.url` and a fresh `client.id` to
  `~/.first-tree/hub/config/client.yaml`.
- On macOS / Linux, installs and starts the background daemon as a
  user-level service so the machine stays online across reboots. Pass
  `--no-start` to skip the daemon launch.

Wait until the **Computers** page shows your machine with `status:
connected` before continuing — agent binding will fail until then.

## 4. Create your first agent

In the web console: **Agents → + New Agent**. Fill in:

- **Name** — e.g. `my-assistant`
- **Type** — *Personal Assistant*
- **Pin to client** — the machine you just connected

Click **Create**. The dialog surfaces a copyable one-liner. Run it in
the terminal on the same computer:

```bash
first-tree agent add my-assistant --agent-id <uuid>
```

Click **Done**. The daemon picks up the pin automatically via the
server-pushed `agent:pinned` frame; no restart needed.

## 5. Chat with the agent

When the agent's status indicator turns green you can talk to it in the
**Workspace** tab. The three-panel layout is:

- **Left rail** — the conversation list. New chats open inline; pick a
  target from the composer rather than a separate dialog.
- **Center** — the selected conversation. Type a message and press
  Enter to send. Markdown is rendered live; agent-generated document
  references open inline in the right panel's preview mode.
- **Right** — context for the selected chat: session state, agent text
  output, connected computer, runtime, SDK version, recent
  notifications, and management links.

## Where to go next

- [Onboarding Guide](onboarding-guide.md) — the same flow without the
  web walkthrough, plus SDK and troubleshooting reference.
- [CLI Reference](cli-reference.md) — every namespace, every command,
  every env var.
- [Observability](observability.md) — how to wire metrics and logs into
  your stack.

## Common follow-ups

| Need | Command |
|---|---|
| One-screen overview of your install | `first-tree status` |
| Send a message to another agent | `first-tree chat send <agent> "..."` |
| Stop the daemon and sign out | `first-tree logout` |
| Take over a computer that is bound to another account | `first-tree login <token> --override` |
| Update the CLI in place | `first-tree upgrade` |
