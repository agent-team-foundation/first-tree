# First Tree Hub Onboarding Operator Playbook

Use this file when an external agent receives an onboarding task such as:

> "Install First Tree Hub CLI, read the onboarding guide with `gh`, and add a member. Server URL is `https://hub.example.com`."

The goal is to run the supported CLI workflow — not to manually create agents via API calls or YAML edits.

## Core Rule

- Use `first-tree-hub onboard` for the end-to-end flow.
- `onboard` depends on a valid credential file; if this machine is not yet signed in, run `first-tree-hub client connect <server-url>` first.
- Ensure `gh` is installed and authenticated (`gh auth login`) — required for GitHub-identity agent creation.

## When the Prompt Starts From Scratch

If the task only gives you a package name, a docs URL, and a server URL, translate it into this sequence:

1. Confirm tooling on the current machine:
   - `gh auth status` — authenticated.
   - `node --version` — `>= 22.16`.
2. Install the CLI:
   - Preferred: `npm install -g @agent-team-foundation/first-tree-hub`.
   - If the caller installed locally (`npm i @agent-team-foundation/first-tree-hub`), invoke via `npx first-tree-hub ...`.
3. Read the canonical guide with `gh` (so you pick up any server-specific nuance):

   ```bash
   gh api repos/agent-team-foundation/first-tree-hub/contents/docs/onboarding-guide.md?ref=main \
     --jq .content | base64 --decode
   ```

4. Sign this machine into the Hub:

   ```bash
   first-tree-hub client connect <server-url>                       # interactive login
   # or
   first-tree-hub client connect <server-url> --token <connect-token>
   # or, in a container / CI:
   first-tree-hub client connect <server-url> --no-service
   ```

5. Dry-run the onboarding to surface missing fields:

   ```bash
   first-tree-hub onboard --check --server <url> --id <id> --type <type> ...
   ```

6. Execute onboarding (creates the agent via Admin API + optional assistant + optional Feishu bot):

   ```bash
   first-tree-hub onboard --server <url> --id <id> --type <type> ...
   ```

7. Start the runtime if this machine should host the agent and no service is installed:

   ```bash
   first-tree-hub client start
   ```

## Prompt Template Interpretation

If the automation says something like:

```text
请先安装 npm i @agent-team-foundation/first-tree-hub
然后使用 gh 命令阅读 docs/onboarding-guide.md，帮我添加成员。
Server URL 是 https://first-tree.staging.unispark.dev/
```

Interpret it as:

- Install (or `npx`-invoke) the published CLI.
- Fetch the onboarding guide with `gh` rather than relying on a browser.
- If this machine has no `~/.first-tree-hub/credentials.json`, run `first-tree-hub client connect https://first-tree.staging.unispark.dev/` first.
- Thread `https://first-tree.staging.unispark.dev/` through `--server` in every onboarding command.
- Use the supported `onboard` flow instead of hand-rolling Admin API calls.

## Minimal Inputs to Collect

- **Required**
  - member `type`: `human`, `personal_assistant`, or `autonomous_agent`
  - `id`
  - `role`
  - `domains`
  - `server` URL (unless already in `client.yaml` / env)
- **Optional**
  - `display-name` (defaults to `id`)
  - `profile` (agent self-description in markdown)
  - `assistant` (only valid when `type=human`)
  - Feishu bot credentials (`--feishu-bot-app-id`, `--feishu-bot-app-secret`) when the bot should be bound

Always prefer `first-tree-hub onboard --check` to reveal missing fields instead of guessing.

## Type-Specific Notes

- **`human`**
  - May include `--assistant <id>` to create a personal assistant in the same step.
  - If a Feishu bot is bound, remind the human to send `/bind <id>` in Feishu after the command completes.
- **`autonomous_agent`**
  - Do **not** pass `--assistant`.
  - Feishu bot binding is optional; no `/bind` follow-up.
- **`personal_assistant`**
  - Usually created via `--assistant` on a human onboard, not as a separate top-level request.

## Example Commands

### Human + assistant

```bash
first-tree-hub onboard --check \
  --server https://first-tree.staging.unispark.dev/ \
  --id alice \
  --type human \
  --role "Engineer" \
  --domains "backend,infrastructure" \
  --assistant alice-assistant
```

```bash
first-tree-hub onboard \
  --server https://first-tree.staging.unispark.dev/ \
  --id alice \
  --type human \
  --role "Engineer" \
  --domains "backend,infrastructure" \
  --assistant alice-assistant
```

### Autonomous agent

```bash
first-tree-hub onboard --check \
  --server https://first-tree.staging.unispark.dev/ \
  --id code-reviewer \
  --type autonomous_agent \
  --role "Code Review" \
  --domains "code-review"
```

```bash
first-tree-hub onboard \
  --server https://first-tree.staging.unispark.dev/ \
  --id code-reviewer \
  --type autonomous_agent \
  --role "Code Review" \
  --domains "code-review"
```

## Common Pitfalls

- **"No credentials found" error** → run `first-tree-hub client connect <server-url>` before re-running `onboard`. Do not try to set an `AGENT_TOKEN` env var; that path no longer exists.
- **`gh` not authenticated** → `gh auth login`. GitHub identity is what `onboard` uses to create the agent.
- **Missing `--server`** → if the automation supplied a URL, thread it explicitly; do not rely on an unconfigured default. `onboard --check` will tell you when it's missing.
- **Trying `onboard` twice with the same ID** → if the first run partially succeeded, `.onboard-state.json` has the previous args; re-running interactive mode picks up where it left off rather than starting over.
