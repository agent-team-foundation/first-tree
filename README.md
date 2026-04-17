# first-tree

**A Git-native knowledge layer for your team — and a three-tool suite that keeps it alive.**

`first-tree` publishes the `first-tree` CLI and its bundled agent skills. A Context Tree is the living source of truth for decisions, ownership, and cross-domain relationships that humans and agents maintain together — `first-tree` is the toolkit that lets agents build, tend, and react to it.

---

## The three tools

```
┌──────────────────────────────────────────────────────────────────────┐
│                         first-tree (umbrella CLI)                    │
├──────────────┬───────────────────────────┬───────────────────────────┤
│    tree      │        gardener           │          breeze           │
│  toolkit     │    local daemon           │     local daemon          │
├──────────────┼───────────────────────────┼───────────────────────────┤
│  init, bind, │ watches source repos →    │ watches gh notifications  │
│  sync,       │ opens issues on the tree  │ → labels / routes / drafts│
│  publish,    │ repo & assigns owners;    │ replies for PRs, issues,  │
│  verify, ... │ responds to sync-PR       │ discussions, reviews.     │
│              │ review feedback.          │                           │
└──────────────┴───────────────────────────┴───────────────────────────┘
                           │
                   ┌───────┴────────┐
                   │ first-tree     │  ← umbrella skill:
                   │    skill       │    methodology, references,
                   │                │    routing into the product skills
                   └────────────────┘
```

| Tool | What it is | When to reach for it |
|------|------------|----------------------|
| **[tree](src/products/tree)** | CLI toolkit — `first-tree tree init/bind/sync/publish/verify/upgrade/workspace/review/generate-codeowners/inject-context` (e.g. `first-tree tree publish` pushes the tree to GitHub and refreshes bound sources). | You want an agent to create, maintain, or bind a Context Tree repo. |
| **[gardener](src/products/gardener)** | Local maintenance daemon — proactively watches source repos and opens/assigns tree issues; responds to review feedback on sync PRs | You want the tree to stay coherent as code changes without asking a human to drive it. |
| **[breeze](src/products/breeze)** | Local inbox daemon — takes over your `gh` login and turns GitHub notifications (PRs, comments, discussions, issues) into a triaged, optionally auto-handled queue | You want an agent sitting on your GitHub notifications so you don't have to. |

Every product ships:
- an operational handbook at `skills/<name>/SKILL.md` (loaded into agents),
- a lazy CLI dispatcher at `src/products/<name>/cli.ts`,
- its own semver'd `VERSION` file, independent from the npm package version (see [docs/architecture/versioning.md](docs/architecture/versioning.md)).

The umbrella skill at [`skills/first-tree/`](skills/first-tree) is the single entry point an agent reads first — it teaches the Context Tree methodology and routes to the three product skills above. Diagnostic/meta commands (`first-tree skill list/doctor/link`) live under [`src/meta/skill-tools/`](src/meta/skill-tools) and are not products.

---

## Quick start

### For an agent (recommended)

Paste one of these into Claude Code, Codex, or any agent — from the root you want to onboard:

**First person on the team:**
```text
Use the latest first-tree CLI (https://github.com/agent-team-foundation/first-tree).
Run `first-tree tree inspect --json` to classify the current folder, then install
the skill and onboard this repo or workspace by creating a new Context Tree.
```

**Joining an existing tree:**
```text
Use the latest first-tree CLI (https://github.com/agent-team-foundation/first-tree).
Run `first-tree tree inspect --json`, install the skill, and bind this repo or
workspace to the existing shared tree at
https://github.com/<your-org>/<your-tree-repo>.
```

### For a human

```bash
# one-off (no global install)
npx -p first-tree first-tree tree inspect --json
npx -p first-tree first-tree tree init

# global install
npm install -g first-tree
first-tree --help          # list products + diagnostics
first-tree --version       # CLI + per-product versions
```

---

## Onboarding modes

`first-tree` models onboarding with three explicit concepts:

- **source / workspace root** — the repo or folder that gets local agent integration
- **tree repo** — the Git repo that stores `NODE.md`, domains, members, decisions
- **binding** — metadata that links a source to a tree

Four first-class paths:

| Scenario | Command |
|----------|---------|
| Single repo + new dedicated tree | `first-tree tree init` |
| Bind to existing shared tree | `first-tree tree bind --tree-path ../org-context --tree-mode shared` |
| Workspace root + shared tree | `first-tree tree init --scope workspace --sync-members` (then `first-tree tree workspace sync`) |
| You're inside the tree repo itself | `first-tree tree init tree --here` |

See [`skills/first-tree/references/onboarding.md`](skills/first-tree/references/onboarding.md) for the full guide, and run `first-tree tree help onboarding` to print it.

---

## Layout after onboarding

```text
<source-repo-or-workspace>/          <tree-repo>/
  .agents/skills/first-tree/           .agents/skills/first-tree/
  .claude/skills/first-tree            .claude/skills/first-tree
  WHITEPAPER.md                        .first-tree/
  AGENTS.md                              VERSION
  CLAUDE.md                              progress.md
  .first-tree/                           tree.json
    source.json                          bindings/<source-id>.json
  … your code …                        source-repos.md
                                       NODE.md
                                       AGENTS.md / CLAUDE.md
                                       members/NODE.md
                                       … tree domains …
```

The source/workspace root is never a tree — it never contains `NODE.md`, `members/`, or tree-scoped `AGENTS.md` / `CLAUDE.md`. Source-side state lives under `.first-tree/source.json`; tree-side state lives under `.first-tree/tree.json` and `.first-tree/bindings/<source-id>.json`.

---

## Repository layout (for contributors)

```text
src/
  cli.ts                  # umbrella dispatcher
  products/
    manifest.ts           # single source of truth for product/meta registration
    tree/                 # tree product (CLI + engine)
    breeze/               # breeze product (CLI + engine + daemon)
    gardener/             # gardener product (CLI + engine)
  meta/
    skill-tools/          # `first-tree skill list/doctor/link` diagnostics
  shared/
    version.ts            # shared VERSION/package.json readers
assets/
  tree/                   # runtime assets installed into user repos
  breeze/                 # breeze dashboard HTML
skills/
  first-tree/             # umbrella skill (methodology + routing)
  tree/ breeze/ gardener/ # per-product operational handbooks
tests/
  tree/ breeze/ gardener/ meta/ e2e/     # grouped by product
docs/                     # maintainer-only implementation notes
evals/                    # maintainer-only evaluation harness
```

See [`AGENTS.md`](AGENTS.md) (== `CLAUDE.md`) for maintainer rules, and [`docs/source-map.md`](docs/source-map.md) for the annotated file map.

---

## Developing

```bash
pnpm install --frozen-lockfile
pnpm validate:skill
pnpm typecheck
pnpm test
pnpm build
pnpm pack            # when package contents change
```

Evals live in [`evals/`](evals) — see `evals/README.md`.

## Package And Command

- The npm package is `first-tree`; the installed CLI command is also `first-tree`.
- The CLI dispatches into three products (`tree`, `breeze`, `gardener`) plus diagnostic meta commands (`skill`). Run `first-tree --help` to see the routing.
- The published package ships **four skill payloads**, each with the same name in the package and when installed into a user repo:
  - `skills/first-tree/` — the umbrella entry-point `first-tree` skill (methodology, references, routing).
  - `skills/tree/`, `skills/breeze/`, `skills/gardener/` — one operational handbook per product CLI.
- In this source repo, `.agents/skills/first-tree/` and `.claude/skills/first-tree/` (plus the three product equivalents) are tracked symlink aliases back to the four `skills/<name>/` payloads, so local agents resolve the same skills the package ships.
- `npx -p first-tree first-tree <command>` is the recommended one-off entrypoint.

## Canonical Documentation

User-facing references ship under `skills/first-tree/references/` and get copied into user repos by `first-tree tree init` / `first-tree tree bind`:

- Methodology overview: `skills/first-tree/references/whitepaper.md`
- Onboarding guide: `skills/first-tree/references/onboarding.md`
- Source/workspace install contract: `skills/first-tree/references/source-workspace-installation.md`
- Upgrade and layout contract: `skills/first-tree/references/upgrade-contract.md`

Decision-grade design knowledge for this project lives in the bound Context Tree under `first-tree-skill-cli/`, not in this repo:

- Canonical architecture: `first-tree-skill-cli/repo-architecture.md`
- Canonical sync design: `first-tree-skill-cli/sync.md`

Repo-local maintainer notes (`docs/source-map.md` and friends) are implementation-only and never ship. `<repo>-tree` is the default sibling name for a dedicated tree repo created by `first-tree tree init`.

---

## Contributing and security

- GitHub issue forms for bugs and feature requests.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) for local setup and validation expectations.
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) for community expectations.
- [`SECURITY.md`](SECURITY.md) for vulnerability reporting.

## License

Apache 2.0
