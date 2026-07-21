---
name: first-tree-file-bug
description: File a GitHub issue about a defect in First Tree itself — the CLI, agent runtime, chat, web app, GitHub integration, GitLab integration, or Context Tree tooling — onto First Tree's own GitHub-hosted public tracker (agent-team-foundation/first-tree). Use only when the user reports that First Tree the platform is broken, errored, crashed, or misbehaving and wants it reported (e.g. "First Tree has a bug", "chat send keeps failing", "the CLI crashed", "给 First Tree 开个 issue 反馈这个 bug"). The skill gathers reproduction steps, the First Tree client/CLI version, the chat ID, the reporting user's ID, OS, and error output, then opens the issue with the user's `gh` CLI. NOT for filing an issue into the user's own or bound source repo — that is an ordinary source-repo issue using the target forge CLI (`gh` for GitHub, `glab` for GitLab), not this skill — and not for bugs in the user's project code or third-party tools.
---

# First Tree File Bug

## Purpose

Turn a user's informal bug report about **First Tree itself** into a
well-formed GitHub issue on `agent-team-foundation/first-tree`, filed with
the user's authenticated `gh` CLI. The value is that the user only has to
say "First Tree has a bug" — this skill does the collection, drafting, and
filing, opens a dedicated chat that follows the issue for tracking, and
reports the issue URL back.

The target repo is **public**. Filing publishes whatever you include, so
gather deliberately, confirm with the user before creating, and never post
secrets (see **Guardrails**).

## When to use

- The defect is in **First Tree** — the CLI (`first-tree …`), the agent
  runtime / client, chat delivery, the web app, notifications, GitHub
  integration, GitLab integration, or Context Tree tooling.
- The user wants it **reported / filed / logged**, not just diagnosed.

## When NOT to use

- The bug is in the **user's own project code**, a dependency, or a
  third-party tool — that is normal debugging, not a First Tree issue.
- The user only wants help understanding or working around the problem
  and has not asked to file anything. Fix or explain first; offer to file
  only if it is a genuine First Tree defect.
- It is a **security vulnerability** — do not open a public issue; point
  the user to the repo's `SECURITY.md` reporting path instead.

## Workflow

### 1. Confirm the scope

State briefly what you understand the bug to be and that it looks like a
First Tree defect worth filing. If it is ambiguous whether the fault is in
First Tree or the user's own setup, resolve that first — do not file an
issue against First Tree for something outside it. If the report is really
about the user's own project or their bound source repo, this is not the
skill: file it into that repo with the target repository's forge CLI
(`gh issue create --repo <their repo>` for GitHub, or `glab issue create
--repo <their repo>` for GitLab) instead of here. If that CLI is not
authenticated, recover with `gh auth login` for GitHub or `glab auth login`
for GitLab.

### 2. Gather the bug context

Collect what the maintainers need to reproduce and triage. Get what you can
yourself; ask the user only for what you genuinely cannot infer (typically
the repro steps and the observed error). Do not over-interrogate.

| Field | How to get it |
|---|---|
| **What happened** | From the user: what they were doing, the expected result, and the actual result. Turn this into numbered reproduction steps. |
| **Error output / logs** | Paste from the user's message or from recent command output in this session. Scrub secrets first (see Guardrails). |
| **Client / CLI version** | Run the First Tree CLI with `--version` (e.g. `first-tree --version` — substitute your channel binary; see **CLI binary** below). |
| **Runtime / provider** | Your agent runtime kind (e.g. `claude-code`, `codex`), if relevant to the bug. |
| **Chat ID** | From the injected **Current Chat Context** block — the `Chat ID:` line, or the `chatId` field of the `first-tree-current-chat-context` JSON payload. |
| **Reporting user ID** | The human participant in this chat: their handle from the Current Chat Context participants list (`type=human`), which is also the `<name>` in the `[From: <name> …]` header of their message. |
| **Operating system** | `uname -srm` (or `sw_vers` on macOS). |

If the user already pasted a stack trace or exact error, capture it
verbatim — it is the highest-signal part of the report.

### 3. Check for an existing issue

Do a quick duplicate scan so you do not file a repeat:

```bash
gh issue list --repo agent-team-foundation/first-tree --search "<key error phrase>" --state all --limit 10
```

If a clear match exists, show it to the user and ask whether to comment on
it instead of opening a new one.

### 4. Draft the issue

Follow the repo's bug-report template. Title as `[Bug] <concise summary>`.
Body:

```markdown
## Summary

<one or two sentences>

## Surface Area

<which part of First Tree: CLI / runtime / chat / web / GitHub integration / GitLab integration / Context Tree>

## Environment

- version: <first-tree --version output>
- runtime: <claude-code | codex | …>
- operating system: <uname / sw_vers>

## Reproduction

1. …
2. …
3. …

## Expected Behavior

<what should have happened>

## Actual Behavior

<what actually happened; include the verbatim error / stack trace>

## First Tree Context

- Chat ID: <chatId>
- Reported by (user): <human participant handle>
- Agent: <your agent id / name>

## Additional Context

<logs, screenshots, related links — secrets scrubbed>
```

Keep it tight and factual. The **First Tree Context** block is what lets
maintainers correlate the report with server-side logs — these are opaque
identifiers, not credentials.

### 5. Confirm before filing

Filing is outward-facing and publishes to a public tracker, so show the
user the drafted title and body **and state the destination explicitly —
this files into `agent-team-foundation/first-tree` (First Tree's own public
tracker), not the user's own repo** — then get an explicit go-ahead before
creating the issue. Incorporate any correction they make.

### 6. File the issue

Write the body to a file so markdown reaches GitHub verbatim, then create:

```bash
gh issue create \
  --repo agent-team-foundation/first-tree \
  --title "[Bug] <summary>" \
  --label bug \
  --body-file <path-to-body.md>
```

`gh` uses the user's own authentication on this host — that is the intended
"file with the user's gh CLI" path. This is GitHub-only because First Tree's
public issue tracker is GitHub-hosted.

### 7. Open a tracking chat and follow the issue

Prefer a dedicated chat over the current one: open a new chat for this bug
and route the issue's webhook events there, so its lifecycle (comments,
labels, close) is tracked in its own thread instead of cluttering the chat
where the bug was reported. Fall back to the current chat only if the
dedicated chat cannot be opened (the `else` branch below).

Create the chat with the reporting user as the recipient, capture the new
chat's ID from the JSON response, then follow the issue **into that chat**:

```bash
# 1. Open the tracking chat; capture the full JSON response (don't pipe
#    straight into a parser that might not be installed — see below).
resp=$(first-tree chat create \
  --to <reporting-user-handle> \
  --topic "Bug: <concise summary>" \
  --description "Tracking First Tree bug: <concise summary> — <issue-url>" \
  -f markdown \
  "Filed a First Tree bug issue: <issue-url>. This chat tracks its progress.")

# 2. Take the new chat's id from the response's data.chatId
#    (shape: {"ok":true,"data":{"chatId":"…"}}). Read it directly, or:
new_chat=$(printf '%s' "$resp" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["chatId"])')

# 3. Follow the issue into the NEW chat — but ONLY with a non-empty id.
#    `--chat ""` does NOT fall back; it fails with NO_CHAT_CONTEXT. So if the
#    chat could not be created or its id not parsed, follow into the current
#    chat instead so the issue is never left unfollowed.
if [ -n "$new_chat" ]; then
  first-tree github follow <issue-url> --chat "$new_chat"
else
  first-tree github follow <issue-url>          # fallback: current chat
fi
```

- `--to <reporting-user-handle>` is the human who reported the bug (the
  handle from step 2), so they get the tracking chat and are woken on it.
- Take the chat id from the `data.chatId` field of the create response.
  Extraction above uses `python3`; `jq -r '.data.chatId'` works too — but do
  not hard-depend on a parser you cannot confirm is installed. When in doubt,
  read `data.chatId` straight from the JSON yourself.
- Set an explicit stable `--topic` yourself — an agent-declared `github
  follow --chat` does **not** auto-rewrite the tracking chat's topic from the
  issue, so without it the chat keeps a low-signal auto-derived label
  (`--description` is set at create time regardless, so the chat still
  self-describes).
- `chat create` is **not idempotent** — create the chat exactly once; if the
  result is uncertain, check `chat list` before retrying rather than
  re-running blindly.
- **Fallback (the example's `else` branch, not optional):** `github follow
  --chat ""` fails with `NO_CHAT_CONTEXT` — it does **not** fall back on its
  own. So when `chat create` fails (e.g. the `--to` handle will not resolve)
  or the id cannot be parsed, follow the issue into the current chat
  (`first-tree github follow <issue-url>`) and tell the user the dedicated
  tracking chat could not be opened. Never leave the issue unfollowed.
- Write the first message and description in the session's working language
  (the examples above are English).

Finally, in the **current** chat, report the issue URL back to the user and
say where it is being tracked: the dedicated chat if one was opened, or (on
the fallback) this chat.

## Guardrails

- **Never publish secrets.** Scrub tokens, API keys, cookies, passwords,
  auth headers, and private URLs from any logs or error output before it
  goes into a public issue. When unsure, redact.
- **Public repo.** Chat ID and user ID are opaque identifiers that help
  triage; they are safe to include, but the confirmation step (5) is
  where the user gets to veto anything they would rather not post.
- **Security issues do not go here** — route to `SECURITY.md`, not a
  public issue.
- **If `gh` is missing or unauthenticated**, do not treat it as a First
  Tree platform gap. Present the fully drafted issue (title + body) to the
  user so they can file it manually, and offer the `gh` install / `gh auth
  login` path; this recovery is GitHub-specific because the First Tree
  tracker is on GitHub.

## CLI binary

Examples use the canonical `first-tree` binary. Substitute the
channel-correct binary named in your briefing (`first-tree` on prod,
`first-tree-staging` on staging, `first-tree-dev` on dev) — it is the same
binary you use for `chat send`. `gh` is the host GitHub CLI and is not
channel-specific.
