---
name: first-tree-welcome
version: 1.1.0
description: Use for a First Tree onboarding first chat, especially natural opening messages like "welcome aboard", "Please help me get started with First Tree", or "Please help me get settled into this team on First Tree." Also covers the production-scan fix first chat ("fix the launch blockers found by my production readiness scan"). Do not use for dedicated tree setup chats, ordinary chats, PR reviews, repo scans, tree writes, or maintenance.
---

# First Tree Welcome

## Scope

Use this skill only when the chat is clearly the onboarding first chat created by
First Tree, including natural messages such as "welcome aboard", "Please help me
get started with First Tree", or "Please help me get settled into this team on
First Tree." Do not use it for ordinary chats, PR reviews, repo scans, tree
writes, or maintenance work.

Two look-alikes that are NOT this launcher, and one that IS:

- **A dedicated tree-build / single-task chat** (you were placed in it, or it IS
  one) — run that task's own skill (`first-tree-seed` to build/seed a tree,
  `first-tree-read` / `first-tree-write` as appropriate), not this launcher flow.
- **A repo-scan chat** — it can open with the same "welcome aboard" line but then
  asks for a repository scan or readiness report; run its own bound scan skill.
- **A production-scan FIX chat is still this launcher** — the opening message
  references an already-completed scan ("fix the launch blockers found by my
  production readiness scan"), carries a `Repository:` line, and usually a
  `Machine-readable findings: https://report.first-tree.ai/<key>.json` line.
  Nothing needs re-scanning: do not look for a scan skill. Treat it as this
  launcher arriving with a pre-selected first task (see "Production-scan fix
  handoff" below).

## What This Is

Make the user feel First Tree's value in two ways:

1. **Concrete value from their code** — read the connected repo, show real
   understanding, and get a bounded first task actually done and verified.
2. **Leverage / parallelism** — First Tree lets an agent run several pieces of
   work at once. When the user picks more than one thing, spin each into its own
   chat so they progress in parallel, and keep this chat as the launcher.

This chat is **value-first and consent-gated**. After you have shown
understanding, you offer a short first-task menu; for an **admin whose team has
no Context Tree yet** that menu includes **building the team's Context Tree** as
a first-class item. Setup never preempts value: you always show understanding
first, you never open with setup, and the user always chooses.

Treat the opening message as the user's onboarding request. Reply naturally,
without exposing skill names or launch mechanics.

## The Flow: read the state, then act

Before your first substantive reply, infer the onboarding state from the
start-chat message, runtime briefing, repo resources, Context Tree binding, and
available local files:

- **role**: admin, invitee, or unclear;
- **code repo**: connected/recommended, local path/URL provided, or none;
- **Context Tree**: no binding, bound-but-empty, bound-and-populated, or unknown;
- **host `gh` / local credentials**: usable or not.

If state is unknown, say what is missing and ask for the smallest useful input.
Do not invent repo access, GitHub authorization, or tree readiness.

### Your first substantive reply

- **No readable code yet** — no repo connected, no local path, no GitHub URL, and
  no readable team context. Make exactly one minimal ask: request one project
  entry point — a local project folder path on this machine or a GitHub repo URL
  — without faking understanding. Recommended shape: "Share one project entry
  point: a local project folder path on this machine, or a GitHub repo URL. I'll
  inspect it first, then suggest a few concrete starter tasks." If they share a
  GitHub URL, use host `gh` first. This ask is a legitimate first result. Do not
  ask for GitHub App authorization first, do not offer the first-task menu yet,
  and do not mention Context Tree setup yet.
- **Readable code available** — a repo is connected and you can read it, or a
  local path / URL was given and you can read it. (A repo that is connected but
  local credentials cannot read it is the "cannot read it" state below — report
  the read failure, do not fake understanding or send a menu.) Your first
  substantive reply must:
  1. State specific understanding from evidence: stack, entry points, important
     modules, tests, TODOs, conventions, risks, or team context you actually
     observed.
  2. Then offer the first-task menu (see below). Do not lead with the menu; lead
     with understanding.
  3. Accept free text as another valid answer.

  Mention the Context Tree in plain product terms ("your team's shared memory")
  — never as internal jargon.

### Production-scan fix handoff (pre-selected first task)

The start-chat message may arrive with the first task already chosen: fixing
the blockers from a completed First Tree production scan. TWO message shapes
are both this handoff — recognize either:

- **With a findings link**: a fix request referencing a production readiness
  scan, a `Repository:` line, and a `Machine-readable findings:
  https://report.first-tree.ai/<key>.json` line.
- **Without a findings link** (the report key did not survive the handoff):
  the same fix request and `Repository:` line, closing with "The scan report
  link didn't carry over, so start by checking access to the repository, then
  ask me to share the report or re-run the scan." No findings line appears at
  all — this is an expected first-class shape, not a malformed message; do
  NOT fall back to the generic first-task menu.

When either shape matches:

1. Skip the first-task menu — the user already chose. Confirm in one short line
   that the blocker work is starting (and, with a findings link, that the scan
   findings are in hand).
2. **With a findings link**: read the findings JSON before touching code. If
   the link is expired or unreachable (it expires roughly 30 days after the
   scan), say so plainly and ask the user to re-run the scan from the report
   page — never guess findings. **Without a readable findings source** (no
   findings line, or the link is dead): check repository access, ask the user
   to share the report or re-run the scan, and STOP there. Do not spawn a fix
   chat and do not start fix work from guessed blockers — a task brief without
   the findings cannot list the blockers it exists to fix. Step 3 applies only
   once a readable findings source exists (a shared report, a findings URL, or
   a fresh scan).
3. **Launcher vs already-dedicated chat** (only with a readable findings
   source — see step 2). If this chat opened with the
   onboarding greeting ("welcome aboard"), it is the launcher: spin the work
   into its own chat with `chat create` addressed to your own agent, topic
   `Fix production scan blockers`, keeping this chat as the launcher (see
   Spawning Task Chats). If the message arrived WITHOUT that greeting — a task
   chat that already carries the fix brief — this chat IS the dedicated fix
   chat: do the work here and do not spawn another. A spawned chat's task
   brief must be self-contained: the repository URL, the findings JSON URL
   (when present), fix blockers in severity order, what to do when access is
   missing (ask for the narrowest GitHub access or a local path), and the
   completion bar — a PR or a verified fix per blocker, with evidence.
4. If the repository is not readable from this machine, follow the normal
   cannot-read rule: state the exact failure and make the smallest access ask;
   do not fake progress on findings alone.
5. Context Tree rules are unchanged: offer a tree build only after the fix work
   has shown value, and only per the existing role/tree-state gates.

### State → action (repo/tree axis; role is the overlay below)

Apply top to bottom; first match wins. The last row is an explicit catch-all —
never fall through silently.

| State | What to do |
| --- | --- |
| No project yet (no repo/path/URL) | Ask for one local project folder path or GitHub repo URL. For GitHub URLs try host `gh` / local credentials first. Do not ask for GitHub authorization first, and do not offer tree build (no code to draw it from). |
| Repo/resource exists but local credentials cannot read it | State the exact read failure. Do not claim private repo contents, do not fake understanding or send a menu. Ask for a local project folder path, accessible URL, or credential setup. |
| Repo readable, tree missing or empty | Show code value, then offer the menu. **For a confirmed admin**, the menu carries BOTH the value-task bundle AND "Build your Context Tree"; otherwise value tasks only. On selection, fan out. |
| Repo readable, tree already populated | Read both, cite concrete evidence, offer value-task options. Do NOT offer tree build (already built); do not seed the tree here. |
| Repo readable, tree state unknown | Give repo-based value; do not invent tree readiness. Offer tree build only once you can confirm the tree is missing/empty AND the human is an admin. |
| Any other state (catch-all) | Give evidence-backed value from whatever is readable; do not invent repo access or tree readiness. If nothing is actionable yet, ask for the smallest useful input. |

### Role overlay (holds in EVERY state above)

Role gates only admin-only setup (building the tree, selecting team repos,
installing the GitHub App), not value.

- **Invitee / member**: NEVER offered tree build, team-repo selection, or GitHub
  App install, and must not mutate org-wide setup — regardless of which state
  matched. Give value from whatever is readable; note that an admin owns/finishes
  team setup. On a not-ready team, offer a meet-the-agent / local-path path now.
- **Unclear**: do not assume admin. Give value from whatever is readable; for an
  admin-only step, say it may require an organization admin and ask who should be
  involved rather than walking the user into an admin surface.

You do not create or bind the tree yourself in this chat. When the user picks
"Build your Context Tree", you SPAWN a dedicated chat and let `first-tree-seed`
own repo creation, binding, and seeding there (see Spawning Task Chats). Never
silently create, bind, or duplicate team-wide setup from this launcher chat.

## The First-Task Menu

After you have shown understanding, offer a first-task menu. A tracked ask needs
**2–4 options** (`chat ask <human> "..." --options '[...]' --multi-select`) — a
one-option ask is invalid — so the menu's shape depends on whether the tree-build
option is available:

- **When you offer "Build your Context Tree"** (admin AND tree missing/empty):
  send a multi-select ask with **two** options — one **bundled value option**
  (label e.g. "Start on these tasks", description naming the 2–4 concrete tasks
  you found: checkout tests, the expired-session TODO, an architecture map…) plus
  **"Build your Context Tree"** (one-line plain gloss: the shared memory future
  agents and teammates start from). Bundling the value tasks keeps this a clean
  two-way choice; the user may pick either, both, or skip.
- **When you do NOT offer tree build** (every other value state): a lone value
  bundle would be an invalid one-option ask, so instead list the **2–4 concrete
  value tasks as individual options** in the multi-select. The user picks the ones
  they want.
- **When there is only one responsible next step, or evidence is thin**: do not
  fake options — recommend it in a normal reply and accept free text.

In all cases:

- Multi-select; several picked ⇒ they run in parallel (one chat per task — see
  Spawning Task Chats).
- **Never send a tracked ask with fewer than two options.**
- Do NOT add a "Skip for now" option; the web ask UI already has a footer Skip.
- Make clear the user can also type another task in free text.
- If there is no readable code yet, do not send this menu — get a project first.

Example shape:

```text
Your acme-dashboard is a Next.js app. app/checkout/recovery.ts has a TODO for
expired-session re-auth with no nearby test, and the routes/data flow isn't
documented yet.

What do you want to kick off? You can pick more than one — I'll run each in its
own chat so they progress in parallel.
- Start on these tasks: checkout tests + the expired-session TODO.
- Build your Context Tree: your team's shared memory for every future agent.

Or type another task.
```

### Choosing fast-value tasks

For the value tasks (bundled or listed individually), pick ones that help the
user feel value quickly. A good one is:

- Evidence-backed: tied to a file, module, TODO, test gap, or behavior you observed.
- Bounded: small enough for a first pass in one short work session.
- Low-risk: avoids large architecture changes, migrations, security-sensitive changes, or broad refactors.
- Verifiable: has a clear check — test, lint, type-check, screenshot, doc diff, or manual acceptance.
- Useful: improves understanding, confidence, correctness, or a real workflow.

Prefer: verify/explain recent changes on a feature branch or uncommitted work;
add or repair a narrow test around an untested flow; explain the architecture
around a concrete entry point; trace one user flow end-to-end; fix a small TODO
or error-handling gap; map the data model or API surface.

Avoid as value tasks: "refactor the codebase" or other broad work; vague
"improve code quality"; claims of bugs without evidence; work needing new
credentials, production access, or irreversible actions before the user agrees.
If repo evidence is thin, choose read-only orientation tasks instead of inventing
implementation work. ("Build your Context Tree" is a menu item in its own right —
it does not belong in this value-task list.)

## Spawning Task Chats

Once the user picks, **do not do the work in this launcher chat**. Fan the
selected work out into parallel chats — **one chat per task**: if the user picked
the value bundle, open one chat for EACH task in it; if they picked individual
value tasks, open one chat per picked task; if they picked the tree build, open
one chat for it. (That per-task parallelism is the leverage the user is meant to
feel.) Open each with:

`first-tree chat create --to <your-own-agent-name> --topic "<short task topic>" "<self-contained task brief>"`

Key mechanics — read these carefully, they are easy to get wrong:

- **Address the new chat to yourself** — `--to <your own agent name>`, to
  yourself specifically, NOT to the user. Self-addressing is the one form that
  wakes you: the server rewrites the opening message's sender to your manager
  (so it is no longer "from you") and mentions you, which wakes you in the new
  chat to do the work. Addressing it to the user instead would not wake you —
  do not "simplify" it that way.
- **The opening message must be a fully self-contained task brief**, written as
  the user assigning the task ("Add checkout tests for the happy path and one
  failure case", "Build our team's Context Tree from the connected code"). This
  matters more than it looks: when you are woken in the spawned chat you will
  **not be able to tell the chat was self-spawned** — because the sender was
  rewritten to your manager, it reads as a fresh task from the user, and that one
  message is the ONLY context you have. So the brief must stand completely on its
  own. Include: the task, the relevant repo/paths, and how "done" is verified. Do
  NOT write a terse pointer like "do task 1".
- **For a value task**: the brief states the change and its verification (test,
  lint, screenshot, doc diff).
- **For "Build your Context Tree"**: the brief is user-visible, so write it in
  plain product language and **name no skill in it** — e.g. "Build our team's
  Context Tree from the connected code — propose an initial structure for me to
  review, then fill it in." When you are woken in that chat, recognize the
  tree-build task and load `first-tree-seed` from the task itself; it resolves the
  tree's state and owns creating + binding + seeding — this launcher does none of
  that.
- Give each chat a clear, stable topic.

Then, back in THIS launcher chat, post a short line naming the chats you opened
so the user can see the parallel streams. As each spawned chat produces a result
(a PR, a passing test, the seed PRs), note it here so the launcher stays the
map of what is in flight.

## Doing the Work & Talking to the User

Lead with the result, be brief, say only what helps the user act next. Do not
narrate process, and do not surface this skill's internals (the state table,
skill names like `first-tree-seed`, "binding", "kickoff", "systemSender") — say
it in plain product terms or not at all. Do not claim; show.

Whether a task runs in a spawned chat (value task) or you are carrying it here,
the onboarding payoff is that the user *sees* it work:

- Run the verification the task implies — a test, lint/type-check, a `browse`
  screenshot, a visible output, or a doc diff — and show the result. Onboarding
  succeeds when the user sees the task genuinely done, not when you report it done.
- Do not say a task is finished, or that a change "should work", without that
  evidence. If you could not verify, say so plainly and name what is left.
- Keep the change minimal and scoped; do not refactor adjacent code on a first task.
- If stuck after a couple of honest attempts, say so and offer the next option
  rather than thrashing.

Avoid:

- **The audit dump** — listing everything you read instead of the 1–3 things that matter.
- **The tour** — narrating UI steps instead of a link or one concrete input.
- **The greeting-about-greeting** — "Welcome! I'm excited to help on your journey…" before any substance.
- **"Should work"** — calling it done without showing the check.

## Guardrails, Consent & Setup Handoff

**Consent gates.** Authorization, repo authorization, Context Tree
creation/binding, `gh repo create`, pushes, PR creation, and destructive actions
all require explicit user consent. The user's pick in the menu IS that consent
for tree build; other authorizations use a tracked ask.

**Role.**

- **Admins** may be offered "Build your Context Tree" (tree missing/empty, after
  value), and guided through GitHub App / repo selection when a chosen task needs
  durable platform capability.
- **Invitees / members** must NOT be offered tree build, team-repo selection, or
  GitHub App install, and must not mutate org-wide setup — in every state. Note
  an admin owns those.
- **Unclear role**: do not assume admin; for an admin-only step, say it may
  require an org admin and ask who to involve rather than routing them into an
  admin surface.

**GitHub / repo access.**

- Prefer a local project folder path + host `gh` for ordinary GitHub work. A
  GitHub URL alone is not a reason to ask for GitHub App installation — try host
  `gh` first.
- Private repo access depends on the member's local credentials. Do not promise
  access to named private repos until reads actually succeed.
- If First Tree says no repo is connected: (1) do not ask for GitHub App
  authorization first; (2) ask for either a local project folder path or a GitHub
  repo URL; (3) local path → inspect it and give the evidence-backed menu;
  (4) GitHub URL → use host `gh` or local git credentials when available; (5) if
  `gh` is missing / unauthenticated / lacks access, explain that exact gap and
  ask for the narrowest recovery: local project folder path, GitHub CLI install,
  or `gh auth login` / account access; (6) do not offer "Build your Context Tree"
  until there is readable code and the human is a confirmed admin.

**Setup handoff (steps you cannot perform — durable GitHub App install, repo
authorization).** Raise them only when the chosen work genuinely needs them, then
guide that one step to completion — do not raise setup as an opening menu, and do
not give brittle click-by-click paths. When you do hand off, give the most
specific stable target available (product deep link; GitHub install URL only when
the URL/App slug is known; otherwise the console base URL plus a durable area like
Settings / Integrations). Do not guess slugs or URLs, and do not expose tokens or
secrets. If the human is not an admin, do not send them into an admin-only
surface; involve the responsible admin.

## Hard Rules

- Read before claiming understanding; use concrete evidence, not generic prose.
- Lead with value understanding; never open with setup.
- Offer "Build your Context Tree" ONLY to an admin whose team tree is
  missing/empty, and only after showing value — never to an invitee, never when
  the tree is already populated. Pushing it anywhere else — to look proactive, or
  because setup is on your mind — is the eager-setup instinct: block it.
- Present choices as a multi-select ask with **2–4 options** — the value tasks
  bundled with the tree-build option when tree build is offered, otherwise the
  value tasks listed individually; never a one-option ask; no "Skip for now"
  option; accept free text. (When there is only one responsible next step, skip
  the ask — recommend it in a normal reply.)
- Fan selected work out into separate chats via `chat create --to <self>`; do not
  do the selected work in this launcher chat.
- Every spawned chat's opening message is a self-contained task brief (task +
  context + how "done" is verified), because it is all the context the woken
  agent has and it reads as if the user sent it.
- Do not create, bind, or seed the Context Tree in this launcher chat —
  `first-tree-seed` owns that in the spawned tree chat.
- Finish each task against its own check and show the evidence; never claim it
  works without verifying.
- Do not perform authorization, repo creation, pushes, or PR creation without
  explicit consent.
- Do not surface skill internals or jargon to the user.
- Do not use retired onboarding skill names such as `first-tree-guide`,
  `first-tree-onboarding`, or `first-tree-kickoff`.
