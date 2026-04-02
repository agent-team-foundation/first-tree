# First Tree Hub Scenario Playbooks

Use this file when the user describes a goal in natural language and you need to translate it into the right First Tree Hub CLI sequence.

## 0. "I do not have first-tree-hub installed yet"

Use this before any operational flow when the machine may not have the CLI.

### Recommended flow

1. Verify Node.js is supported:

```bash
node --version
```

2. Install and verify the CLI:

```bash
npm install -g @agent-team-foundation/first-tree-hub
first-tree-hub --version
```

3. If the user will use `onboard` or `agent token bootstrap`, make sure GitHub CLI is authenticated:

```bash
gh auth status
```

### What to remember

- First Tree Hub requires Node.js `>= 22.16`.
- Do not jump straight to `server start`, `client start`, or `onboard` on a machine where installation is still unknown.

## 1. "Help me get First Tree Hub running locally"

Use this when the user is setting up a local Hub for the first time.

### Recommended flow

1. If installation is unknown, do scenario 0 first.

2. Start with:

```bash
first-tree-hub server start
```

3. If the user wants a non-interactive setup, switch to:

```bash
first-tree-hub server start --no-interactive
```

and make sure the required environment variables or config already exist.

4. If startup fails, move to:

```bash
first-tree-hub server doctor
first-tree-hub status
```

### What to remember

- `server start` is the happy-path bootstrap command.
- It can provision Docker PostgreSQL, run migrations, create the first admin, and serve the web UI.
- If the user already has PostgreSQL, prefer `--database-url` instead of forcing Docker.
- If the CLI is not installed yet, installation is part of the correct flow rather than a side detail.

## 2. "Connect my local agent machine to an existing Hub"

Use this when the Hub server already exists and the user wants a local client runtime.

### Recommended flow

1. Ensure client config points at the server:

```bash
first-tree-hub config setup -c
```

or:

```bash
first-tree-hub config set -c server.url http://host:8000
```

2. Add the local agent config:

```bash
first-tree-hub agent add <name> --token <token>
```

3. Start the runtime:

```bash
first-tree-hub client start
```

4. If something looks wrong, inspect:

```bash
first-tree-hub client doctor
first-tree-hub client status
```

### What to remember

- `agent add` is local-only configuration.
- `client start` runs all locally configured agents, not just one.

## 3. "Onboard a new human member"

Use this when the user wants to add a real person to the team through the supported identity flow.

### Recommended flow

1. Dry-run requirements first:

```bash
first-tree-hub onboard --check --id <id> --type human --role "<role>" --domains "<d1,d2>"
```

2. Create the Context Tree PR:

```bash
first-tree-hub onboard --id <id> --type human --role "<role>" --domains "<d1,d2>"
```

3. After the PR is merged, continue:

```bash
first-tree-hub onboard --continue
```

4. Start the local runtime if this machine should run the assistant:

```bash
first-tree-hub client start
```

### What to remember

- `onboard` creates a PR in the Context Tree repo, not in `first-tree-hub`.
- For humans, a personal assistant is optional and may be created with `--assistant <id>`.
- If a Feishu bot is configured for the assistant path, the human usually still needs to send `/bind <id>` in Feishu afterwards.

## 4. "Onboard a standalone autonomous agent"

Use this when the new member is a bot with no human owner.

### Recommended flow

1. Check:

```bash
first-tree-hub onboard --check --id <id> --type autonomous_agent --role "<role>" --domains "<d1,d2>"
```

2. Create the Context Tree PR:

```bash
first-tree-hub onboard --id <id> --type autonomous_agent --role "<role>" --domains "<d1,d2>"
```

3. After merge:

```bash
first-tree-hub onboard --continue
first-tree-hub client start
```

### What to remember

- Do not use `--assistant` for `autonomous_agent`.
- Feishu bot binding is optional here, unlike the human `/bind` flow.

## 5. "Why can't the client connect?" or "Why does startup fail?"

Use this for diagnosis before editing code.

### Recommended flow

1. Check top-level state:

```bash
first-tree-hub status
```

2. Run the relevant doctor:

```bash
first-tree-hub client doctor
```

or:

```bash
first-tree-hub server doctor
```

3. Inspect effective config:

```bash
first-tree-hub config list -c
first-tree-hub config list -s
```

4. If the server should already be running, probe health directly:

```bash
first-tree-hub server status
```

### What to remember

- Prefer diagnosis commands before changing YAML files by hand.
- Server issues and client issues often look similar; make the user goal explicit before debugging.

## 6. "Help me debug messaging between agents"

Use this when the user wants to verify delivery, inspect chats, or send test messages manually.

### Recommended flow

1. Make sure agent debug auth is available:

```bash
export FIRST_TREE_HUB_TOKEN=...
```

2. Send a message:

```bash
first-tree-hub agent send <agentId> "hello"
```

or to an existing chat:

```bash
first-tree-hub agent send <chatId> "hello" --chat
```

3. Inspect chats and history:

```bash
first-tree-hub agent chats
first-tree-hub agent history <chatId>
```

4. Fall back to low-level inbox polling if needed:

```bash
first-tree-hub agent pull
```

### What to remember

- These commands are for debugging and operator visibility, not the normal runtime path.
- If a user only wants to run their agents normally, `client start` is the main flow.

## 7. "Change how the CLI behaves"

Use this when the user wants a code change rather than an operational action.

### Recommended flow

1. Find the matching command handler in `packages/command/src/commands/`.
2. Move behavior into `packages/command/src/core/` if the logic is reusable.
3. Update the corresponding docs in `docs/cli-reference.md` or `docs/onboarding-guide.md`.
4. Validate with the smallest relevant command/package test set.

### What to remember

- Command handlers should stay thin.
- Config changes usually require updates in `packages/shared/src/config/`.
- Onboarding changes often touch both `commands/onboard.ts` and `core/onboard.ts`.
