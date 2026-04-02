# First Tree Hub Onboarding Operator Playbook

Use this file when an external agent receives an onboarding task such as "install First Tree Hub CLI, read the onboarding guide with `gh`, and add a member."

## Core Rule

- Use `first-tree-hub onboard` for the workflow.
- Do not manually edit the Context Tree, create git branches, or open PRs by hand unless the CLI flow is broken and the user explicitly wants a manual fallback.

## When the Prompt Starts From Scratch

If the task only gives you a package name, a docs URL, and a server URL, normalize it into this sequence:

1. Confirm tooling:
   - `gh` is installed and authenticated with write access to the Context Tree repository.
   - Node is new enough to run the published CLI.
2. Install the CLI:
   - Preferred: `npm install -g @agent-team-foundation/first-tree-hub`
   - If the caller installed locally with `npm i @agent-team-foundation/first-tree-hub`, use `npx first-tree-hub ...`
3. Read the canonical guide with `gh`:

```bash
gh api repos/agent-team-foundation/first-tree-hub/contents/docs/onboarding-guide.md?ref=main --jq .content | base64 --decode
```

4. Run readiness first:

```bash
first-tree-hub onboard --check --server <url> ...
```

5. Run Phase 1 to create the Context Tree PR:

```bash
first-tree-hub onboard --server <url> ...
```

6. After the PR is merged, run Phase 2:

```bash
first-tree-hub onboard --continue --server <url> ...
```

7. Start the runtime when this machine should host the configured agent:

```bash
first-tree-hub client start
```

## Prompt Template Interpretation

If the automation says something like:

```text
请先安装 npm i @agent-team-foundation/first-tree-hub
然后使用 gh 命令阅读 docs/onboarding-guide.md，帮我添加成员。
Server url 是 https://first-tree.staging.unispark.dev/
```

interpret it as:

- Install or invoke the published CLI.
- Fetch the guide with `gh` rather than relying on a browser-only read.
- Use `https://first-tree.staging.unispark.dev/` as the Hub server URL in the onboarding commands.
- Execute the supported `onboard` flow instead of hand-editing member files.

## Minimal Inputs to Collect

- Required:
  - member type: `human`, `personal_assistant`, or `autonomous_agent`
  - `id`
  - `role`
  - `domains`
  - `server` URL when it is not already configured
- Optional:
  - `display-name`
  - `assistant` only for `human`
  - Feishu bot credentials only when a bot binding should be created

Prefer `first-tree-hub onboard --check` to reveal missing fields instead of guessing.

## Type-Specific Notes

- `human`
  - May include `--assistant <id>` to create a personal assistant.
  - If Feishu bot binding is configured, remind the human to send `/bind <id>` afterwards.
- `autonomous_agent`
  - Do not use `--assistant`.
  - Feishu bot binding is optional.
- `personal_assistant`
  - Usually created through the human flow rather than as a separate top-level request.

## Example Commands

### Human + assistant

```bash
first-tree-hub onboard \
  --check \
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
first-tree-hub onboard \
  --check \
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
