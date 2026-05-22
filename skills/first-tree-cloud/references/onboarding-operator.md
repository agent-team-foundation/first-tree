# First Tree Hub Onboarding Operator Playbook

Use this file when an external agent receives an onboarding task such as:

> "Install First Tree Hub CLI, read the onboarding guide with `gh`, and add a member. Server URL is `https://hub.example.com`."

The single-shot `onboard` command was retired in Phase 1A of the
repo-merge refactor. Onboarding is now a sequence of explicit verbs:
`login` to bind the machine, `agent create` to register the agent on the
Hub, optional `agent bind bot|user` for Feishu, then `daemon start` to
bring the agent online.

## Core Rules

- Each verb in the sequence depends on a valid credential file. If this machine is not yet signed in, run `first-tree login <token>` first (paste the connect token from the Hub web console's *Computers → New Connection* dialog).
- Ensure `gh` is installed and authenticated (`gh auth login`) — required for GitHub-identity agent creation.
- Always run `first-tree status` after each verb to verify state before proceeding.

## When the Prompt Starts From Scratch

If the task only gives you a package name, a docs URL, and a server URL, translate it into this sequence:

1. Confirm tooling on the current machine:
   - `gh auth status` — authenticated.
   - `node --version` — `>= 22.16`.
2. Install the CLI:
   - Preferred: `npm install -g first-tree`.
   - If the caller installed locally (`npm i first-tree`), invoke via `npx first-tree ...`.
3. Read the canonical guide with `gh` (so you pick up any server-specific nuance):

   ```bash
   gh api repos/agent-team-foundation/first-tree/contents/docs/onboarding-guide.md?ref=main \
     --jq .content | base64 --decode
   ```

4. Sign this machine into the Hub:

   ```bash
   first-tree login <connect-token>
   # or, in a container / CI:
   first-tree login <connect-token> --no-start
   ```

5. Create the agent record on the Hub and bind it to this client:

   ```bash
   first-tree agent create <name> \
     --server <url> --type <human|personal_assistant|autonomous_agent> \
     --client-id "$(first-tree config get client.id | awk '{print $2}')"
   ```

6. (Optional) Bind a Feishu bot to the agent:

   ```bash
   first-tree agent bind bot --platform feishu \
     --app-id "$FEISHU_APP_ID" --app-secret "$FEISHU_APP_SECRET" \
     --agent <name>
   ```

7. Start the daemon if this machine should host the agent and no service is installed:

   ```bash
   first-tree daemon start
   ```

## Prompt Template Interpretation

If the automation says something like:

```text
请先安装 npm i first-tree
然后使用 gh 命令阅读 docs/onboarding-guide.md，帮我添加成员。
Server URL 是 https://first-tree.staging.unispark.dev/
```

Interpret it as:

- Install (or `npx`-invoke) the published CLI.
- Fetch the onboarding guide with `gh` rather than relying on a browser.
- If this machine has no `~/.first-tree/hub/credentials.json`, run `first-tree login <token>` first (paste a connect token from the Hub web console's *Computers → New Connection* dialog — its `iss` claim carries the hub URL).
- Thread `https://first-tree.staging.unispark.dev/` through `--server` in every command.
- Use the supported `agent create` + `agent bind` + `daemon start` sequence instead of hand-rolling Admin API calls.

## Minimal Inputs to Collect

- **Required**
  - agent `name`
  - agent `type`: `human`, `personal_assistant`, or `autonomous_agent`
  - `client-id` (run `first-tree config get client.id` to read it)
  - `server` URL (unless already in `client.yaml` / env)
- **Optional**
  - `display-name` (defaults to `name`)
  - `runtime` (defaults to `claude-code`)
  - Feishu bot credentials (`--app-id`, `--app-secret`) — passed to `agent bind bot`, not `agent create`
  - `org` (only when the member belongs to multiple organizations)

## Type-Specific Notes

- **`human`**
  - After creating the human agent, create a separate `personal_assistant` agent if needed (`agent create <assistant-name> --type personal_assistant`).
  - If a Feishu bot is bound, remind the human to send `/bind <name>` in Feishu after the command completes.
- **`autonomous_agent`**
  - Standalone — no companion assistant.
  - Feishu bot binding is optional; no `/bind` follow-up.
- **`personal_assistant`**
  - Usually paired with a human agent on the same machine.

## Example Commands

### Human + assistant

```bash
first-tree login <token>                                 # one-time

CLIENT_ID=$(first-tree config get client.id | awk '{print $2}')

first-tree agent create alice \
  --server https://first-tree.staging.unispark.dev/ \
  --type human --display-name "Alice" --client-id "$CLIENT_ID"

first-tree agent create alice-assistant \
  --server https://first-tree.staging.unispark.dev/ \
  --type personal_assistant --client-id "$CLIENT_ID"

first-tree agent bind bot --platform feishu \
  --app-id "$FEISHU_APP_ID" --app-secret "$FEISHU_APP_SECRET" \
  --agent alice-assistant

first-tree daemon start
```

### Autonomous agent

```bash
first-tree login <token>

first-tree agent create code-reviewer \
  --server https://first-tree.staging.unispark.dev/ \
  --type autonomous_agent --display-name "Code Review" \
  --client-id "$(first-tree config get client.id | awk '{print $2}')"

first-tree daemon start
```

## Common Pitfalls

- **"No credentials found" error** → run `first-tree login <token>` before re-running `agent create`. Do not try to set an `AGENT_TOKEN` env var; that path no longer exists.
- **`gh` not authenticated** → `gh auth login`. GitHub identity is what `agent create` uses to attribute the new agent.
- **Missing `--server`** → if the automation supplied a URL, thread it explicitly; do not rely on an unconfigured default.
- **Trying to take over a machine bound to a different user** → use `first-tree login <token> --override` instead of `logout` + `login`. It transfers ownership and unpins the previous owner's agents in a single transaction.
