---
name: Gardener workflow mode (push)
description: Step-by-step guide for a codebase-maintainer agent to install a self-hosted GitHub Actions workflow that replaces the gardener service with event-driven, per-PR tree-issue sync.
---

# Gardener — workflow mode (push)

> **Audience.** You are an agent operating inside a **codebase repo** (not
> a tree repo). The user asked you to set up automatic Context Tree
> sync on merge. Read this once, then walk the user through the steps
> below in order — do **not** skip the preflight or the auth caveats.

## What workflow mode replaces

There are two ways to keep a Context Tree in sync with a codebase:

1. **Pull mode (gardener service).** A long-running `first-tree gardener`
   process polls the codebase's PRs/issues from outside, posts verdicts,
   and files tree-repo issues on merge. Use this when you cannot push
   workflow files to the codebase repo.
2. **Push mode (this doc).** A `.github/workflows/first-tree-sync.yml`
   file inside the codebase repo runs `first-tree gardener comment` on
   every PR open/sync/merge. Same verdict comments, same tree-repo
   issue creation, but driven by the codebase's own Actions runner —
   **no gardener service is needed**.

Push mode wins on latency, has zero infra, and stops any external
service from needing credentials to your repo. It requires push access
to the codebase repo (to land the workflow file) and a cross-repo PAT
(so the workflow can open issues in the tree repo).

## Preflight — do these three things before touching any files

1. **Confirm the user wants push mode.** If they don't have push access
   to the codebase, push mode is not an option — fall back to the
   pull-mode guidance in `SKILL.md`.
2. **Confirm the tree repo slug.** You need `owner/name` for the tree
   repo. Ask the user if they haven't already given it. The slug must
   match the real GitHub repo — a typo here produces a broken workflow.
3. **Confirm the codebase repo slug.** Usually derivable from
   `gh repo view --json nameWithOwner -q .nameWithOwner`. Use this for
   the `gh secret set --repo ...` step below.

Do **not** proceed if any of these are unclear.

## Step 1 — scaffold the workflow file

Run the installer from the codebase repo root:

```bash
npx -p first-tree first-tree gardener install-workflow \
  --tree-repo <OWNER>/<TREE_REPO_NAME>
```

This writes `.github/workflows/first-tree-sync.yml`. Re-run with
`--force` if you need to overwrite an existing file. Use `--dry-run`
first if you want to preview the yaml without writing.

What the workflow does on every PR:

- Checks out the codebase and the tree repo side-by-side on the runner
- Runs `first-tree gardener comment --pr N --repo <codebase> --tree-path
  <tree-checkout> --assign-owners`
- Gardener posts its verdict comment on the PR (same format as pull
  mode), and on merge, creates a tree-repo issue assigned to the NODE
  owners resolved from the tree's generated `CODEOWNERS`

## Step 2 — set the `TREE_REPO_TOKEN` secret

The workflow needs a PAT with `contents:read` (to clone the tree repo)
and `issues:write` (to create the tree-repo issue). Two paths.

### Quick path — reuse the maintainer's local `gh` login

**Stop and ask the user to confirm the three caveats before running
anything.** This path is fast but has real tradeoffs:

- The token is the user's **account-level PAT**, so its scopes will be
  broader than what the workflow strictly needs.
- Every issue the workflow opens and assigns will be **recorded in the
  audit log as the user's action**, not a bot's.
- When the user eventually rotates that PAT, **CI will silently fail**
  until a new secret is set.

Only after the user acknowledges these three points, run:

```bash
# 1. Verify we have a local gh token with access to the tree repo
gh auth status
gh api "repos/<OWNER>/<TREE_REPO_NAME>" --jq '.permissions'

# 2. Pipe the token directly into the secret — no echoing, no temp file
gh auth token | gh secret set TREE_REPO_TOKEN \
  --repo <CODEBASE_OWNER>/<CODEBASE_NAME> \
  --body -
```

Never print the token, never write it to a file, never paste it into
chat. If `gh auth token` fails or the repo permissions check shows no
push on the tree repo, switch to the fallback path below.

### Fallback path — fresh scoped PAT

If the quick path is not acceptable (audit concerns, token scope too
broad, user prefers a dedicated token), create a new fine-grained PAT:

1. Open:
   `https://github.com/settings/tokens/new?scopes=repo&description=first-tree-sync`
   (fine-grained tokens work too; they need `Issues: Read and write`
   and `Contents: Read` on the tree repo only.)
2. Have the user paste the token **privately into your terminal** —
   do not let the token appear in chat history. Then run:

   ```bash
   printf '%s' "$TOKEN" | gh secret set TREE_REPO_TOKEN \
     --repo <CODEBASE_OWNER>/<CODEBASE_NAME> \
     --body -
   unset TOKEN
   ```

## Step 3 — set the `ANTHROPIC_API_KEY` secret

`gardener comment` needs a classifier to produce a verdict. When
`ANTHROPIC_API_KEY` is unset, the CLI **refuses to post** (see PR #255)
rather than silently degrading to a hard-coded template. This is the
intended fail-closed behaviour for push mode.

If your shell already has `ANTHROPIC_API_KEY` exported, pipe it directly
into the repo secret without echoing it or pasting it into chat:

```bash
printf '%s' "$ANTHROPIC_API_KEY" | gh secret set ANTHROPIC_API_KEY \
  --repo <CODEBASE_OWNER>/<CODEBASE_NAME> \
  --body -
```

If the variable is not already exported locally, ask the user to paste
it privately into your terminal, then run:

```bash
printf '%s' "$TOKEN" | gh secret set ANTHROPIC_API_KEY \
  --repo <CODEBASE_OWNER>/<CODEBASE_NAME> \
  --body -
unset TOKEN
```

Never print the key, never write it to a file, and never paste it into
chat.

The generated workflow also reads an optional `GARDENER_CLASSIFIER_MODEL`
secret if you need to pin a specific Anthropic model; omit it to use the
built-in default.

## Step 4 — commit and open a PR

Stage the new workflow file and open a PR for review:

```bash
git checkout -b first-tree/install-sync-workflow
git add .github/workflows/first-tree-sync.yml
git commit -m "ci: install first-tree gardener sync workflow"
gh pr create --fill
```

Let a human reviewer approve the workflow addition — CI changes
deserve a second set of eyes.

## Step 5 — verify on the next merge

After the workflow PR merges:

1. Watch the first PR merge after install. The Actions tab should show
   a green `First-Tree Sync` run.
2. Open the tree repo's issues page
   (`https://github.com/<OWNER>/<TREE_REPO_NAME>/issues`). A new issue
   titled `[gardener] tree update needed for ...` should appear,
   assigned to the NODE owners resolved from `CODEOWNERS`.
3. If no issue was filed, check the Actions run logs for the
   `BREEZE_RESULT:` line — it shows why gardener skipped (e.g.
   `TREE_REPO_TOKEN unset`, `tree-repo auth/access error`,
   `already linked`).

## Troubleshooting

- **`TREE_REPO_TOKEN unset`** — secret not installed or scoped to a
  different repo. Re-run Step 2 with the correct `--repo`.
- **Low-signal `INSUFFICIENT_CONTEXT` review** — `ANTHROPIC_API_KEY` is
  not available to the workflow job, so gardener fell back to the
  default no-classifier path. Re-run Step 3 with the correct `--repo`,
  or add the secret at the org/environment level used by this repo.
- **`tree-repo auth/access error (401/403/404)`** — PAT lacks
  `issues:write` or `contents:read` on the tree repo, or points at the
  wrong repo. Regenerate with the scopes in Step 2.
- **Issue created but nobody assigned** — either the NODE owners are
  not tree-repo collaborators (GitHub rejects non-collaborator
  assignees and gardener retries without), or `CODEOWNERS` has no
  entry matching the cited nodes. Run `first-tree tree
  generate-codeowners` in the tree repo to regenerate.
- **Gardener left no comment on the PR** — the PR has the
  `first-tree:sync` label (workflow skips these) or the author is
  gardener itself (self-loop guard).

## Appendix — GitHub App instead of PAT

For long-lived deployments where a personal PAT is the wrong trust
model, register a GitHub App with `Issues: Read and write` and
`Contents: Read` on the tree repo, install it on the codebase repo,
and swap Step 2 for:

1. Use `actions/create-github-app-token@v1` in the workflow to mint a
   short-lived installation token.
2. Store the App ID and private key as `FIRST_TREE_APP_ID` and
   `FIRST_TREE_APP_PRIVATE_KEY` secrets on the codebase.
3. Adjust the workflow to set `TREE_REPO_TOKEN` from the minted token
   instead of `secrets.TREE_REPO_TOKEN`.

The `install-workflow` command does not emit the App-flavored yaml —
edit the generated file by hand for this case, or open an issue on
`agent-team-foundation/first-tree` if you want a `--auth github-app`
flag.
