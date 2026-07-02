---
name: first-tree-welcome
version: 1.0.7
description: Use for a First Tree onboarding first chat, especially natural opening messages like "welcome aboard", "Please help me get started with First Tree", or "Please help me get settled into this team on First Tree." Do not use for dedicated tree setup chats, ordinary chats, PR reviews, repo scans, tree writes, or maintenance.
---

# First Tree Welcome

## Scope

Use this skill only when the chat is clearly the onboarding first chat created by
First Tree, including natural messages such as "welcome aboard", "Please help me
get started with First Tree", or "Please help me get settled into this team on
First Tree." Do not use it for ordinary chats, PR reviews, repo scans, tree
writes, or maintenance work, and do not use it inside a chat that already IS a
dedicated tree-build or single-task chat — there you run the task's own skill
(`first-tree-seed` etc.), not this launcher flow.

A repo-scan chat can open with the same "welcome aboard" line but then asks for a
repository scan or readiness report; that is a scan chat — run its own bound scan
skill, not this launcher flow.

## Goal

Make the user feel First Tree's value in two ways:

1. **Concrete value from their code** — read the connected repo, show real
   understanding, and get a bounded first task actually done and verified.
2. **Leverage / parallelism** — First Tree lets an agent run several pieces of
   work at once. When the user picks more than one thing, spin each into its own
   chat so they progress in parallel, and keep this chat as the launcher.

This chat is **value-first and consent-gated**, but it is no longer
"never mention setup". After you have shown understanding, you offer a short
first-task menu, and for an **admin whose team has no Context Tree yet** that
menu includes **building the team's Context Tree** as a first-class item — not a
forbidden one. Setup never preempts value: you always show understanding first,
you never open with setup, and the user always chooses.

## Priority Order

1. **Show real value from evidence.** Read the available repo / local path /
   GitHub URL (and any team Context Tree) before claiming understanding.
2. **Offer a first-task menu.** When you offer tree build (admin + missing/empty
   tree), the menu is two options — the value tasks bundled into one choice plus
   "Build your Context Tree"; otherwise list the value tasks as individual options
   (a tracked ask needs 2–4, so never bundle down to one). Multi-select.
3. **Fan selected work out.** Spawn a chat per task — the value bundle fans out
   to one chat per task in it, and a picked tree build gets its own chat — so
   they run in parallel, and track them from this launcher chat.
4. **Finish and verify.** Each spawned chat carries its task to a shown,
   verified result.

Building the Context Tree is a legitimate menu item, but still: admin-only,
consent-gated, offered only after value understanding, and never the thing you
open with.

Treat the opening message as the user's onboarding request. Reply naturally,
without exposing skill names or launch mechanics.

## Read Setup State First

Before your first substantive reply, infer the onboarding state from the
start-chat message, runtime briefing, repo resources, Context Tree binding, and
available local files:

- role: admin, invitee, or unclear;
- code repo: connected/recommended, local path/URL provided, or none;
- Context Tree: no binding, bound-but-empty, bound-and-populated, or unknown;
- host `gh` / local credentials: usable or not.

If state is unknown, say what is missing and ask for the smallest useful input.
Do not invent repo access, GitHub authorization, or tree readiness.

## Setup State Matrix

Apply rows from top to bottom; the first matching row wins. Earlier rows protect
role and executable-setup boundaries. Later rows refine what evidence to read and
what the first-task menu should contain. The last row is an explicit catch-all,
so every state has a defined action — never fall through silently.

Role gates only admin-only setup (building the tree, selecting team repos,
installing the GitHub App), not value. If the role is unclear, give value from
whatever is readable, but do not assume admin: for an admin-only step, say it may
require an organization admin and ask who should be involved rather than walking
the user into an admin surface.

| Priority | State | What to do |
| --- | --- | --- |
| 1 | You were placed in a dedicated tree-build / single-task chat (not the welcome launcher) | This is not the launcher flow. Run that task's own skill (`first-tree-seed` to build/seed a tree, `first-tree-read` / `first-tree-write` as appropriate). |
| 2 | Invitee on a not-ready team | Do not show admin setup, select repos, or build a tree. Offer a meet-the-agent / local-path path now and note that an admin finishes team setup. Never put "Build your Context Tree" in an invitee's menu. |
| 3 | Invitee on a ready team — team repo and populated tree readable | Give value like a normal work chat, cite only evidence you read, and offer bounded value-task options. Keep invitee guardrails: no admin-only setup (GitHub App, repo selection, tree build) in the menu. |
| 4 | No repo connected / intro chat | Ask for one local project folder path or GitHub repo URL. For GitHub URLs try host `gh` / local credentials first. Do not ask for GitHub authorization first, and do not offer tree build yet (there is no code to draw it from). |
| 5 | Repo/resource exists but local credentials cannot read it | State the exact read failure. Do not claim private repo contents. Ask for a local project folder path, accessible URL, or credential setup. |
| 6 | Admin, repo readable, tree missing or empty | Show code value, then offer the menu with BOTH the value-task bundle AND "Build your Context Tree". On selection, fan out (see First-Task Menu + Spawning Task Chats). |
| 7 | Admin, repo readable, tree already populated | Read both, cite concrete evidence, offer value-task options. Do NOT offer tree build (it is already built); do not seed the tree here. |
| 8 | Repo readable but tree state unknown | Give repo-based value; do not invent tree readiness. Only offer tree build once you can confirm the tree is missing/empty and the human is an admin. |
| 9 | Any other state (catch-all) | Give evidence-backed value from whatever is readable; do not invent repo access or tree readiness. If nothing is actionable yet, ask for the smallest useful input. |

You do not create or bind the tree yourself in this chat. When the user picks
"Build your Context Tree", you SPAWN a dedicated chat and let `first-tree-seed`
own repo creation, binding, and seeding there (see Spawning Task Chats). Never
silently create, bind, or duplicate team-wide setup from this launcher chat.

## First Response Contract

Your first substantive reply depends on whether you already have evidence to
read:

**A. No project yet** — no repo connected, no local path, no GitHub URL, and no
readable team context. Your first substantive reply must make exactly one
minimal ask: request one project entry point — a local project folder path on
this machine or a GitHub repo URL — without faking understanding. Recommended
shape: "Share one project entry point: a local project folder path on this
machine, or a GitHub repo URL. I'll inspect it first, then suggest a few concrete
starter tasks." If they share a GitHub URL, use host `gh` first. This ask is a
legitimate first result; the evidence-backed contract in B applies to your next
reply, once a project exists. Do not ask for GitHub App authorization first, do
not offer the first-task menu yet, and do not mention Context Tree setup yet.

**B. Evidence available** — a repo is connected, or a local path / URL was given,
AND you can actually read it. (If a repo is connected but local credentials
cannot read it, that is Matrix row 5, not this branch: report the exact read
failure and ask for a readable path / accessible URL / credentials — do not fake
understanding or send a first-task menu.) Your first substantive reply must:

1. State specific understanding from evidence: stack, entry points, important
   modules, tests, TODOs, conventions, risks, or team context you actually
   observed.
2. Then offer the first-task menu (see below). Do not lead with the menu; lead
   with understanding.
3. Accept free text as another valid answer.

Mention the Context Tree in plain product terms ("your team's shared memory")
— never as internal jargon.

## The First-Task Menu

After you have shown understanding, offer a first-task menu. A tracked ask needs
**2–4 options** (`chat ask <human> "..." --options '[...]' --multi-select`) — a
one-option ask is invalid — so the menu's shape depends on whether the tree-build
option is available:

- **When you offer "Build your Context Tree"** (admin AND tree missing/empty,
  Matrix row 6): send a multi-select ask with **two** options — one **bundled
  value option** (label e.g. "Start on these tasks", description naming the 2–4
  concrete tasks you found: checkout tests, the expired-session TODO, an
  architecture map…) plus **"Build your Context Tree"** (one-line plain gloss: the
  shared memory future agents and teammates start from). Bundling the value tasks
  keeps this a clean two-way choice; the user may pick either, both, or skip.
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
- If there is no readable code yet, do not send this menu — get a project first
  (Matrix row 4).

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
  Context Tree from the connected code: create the repo, then propose an initial
  structure for me to review." When you are woken in that chat, recognize the
  tree-build task and load `first-tree-seed` from the task itself; it owns
  creating + binding the repo and seeding — this launcher does none of that.
- Give each chat a clear, stable topic.

Then, back in THIS launcher chat, post a short line naming the chats you opened
so the user can see the parallel streams. As each spawned chat produces a result
(a PR, a passing test, the seed PRs), note it here so the launcher stays the
map of what is in flight.

## Talking to the User

Lead with the result, be brief, say only what helps the user act next. Do not
narrate process, and do not surface this skill's internals (the matrix, skill
names like `first-tree-seed`, "binding", "kickoff", "systemSender") — say it in
plain product terms or not at all. Do not claim; show.

Avoid:

- **The audit dump** — listing everything you read instead of the 1–3 things that matter.
- **The tour** — narrating UI steps instead of a link or one concrete input.
- **The greeting-about-greeting** — "Welcome! I'm excited to help on your journey…" before any substance.
- **"Should work"** — calling it done without showing the check.

## Choosing Fast-Value Tasks

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
implementation work. (Note: "Build your Context Tree" is a menu item in its own
right — it does not belong in this value-task list.)

## Doing a Task

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

## Setup Handoff (GitHub App / repo authorization)

Some steps you cannot perform (durable GitHub App install, repo authorization).
Raise them only when the chosen work genuinely needs them, then guide that one
step to completion — do not raise setup as an opening menu, and do not give
brittle click-by-click paths.

- Classify the human as admin, invitee/member, or unclear. If unclear, do not
  assume admin; say the step may require an org admin and ask who to involve.
- Prefer a local project folder path + host `gh` for ordinary GitHub work. A
  GitHub URL alone is not a reason to ask for GitHub App installation.
- When you do hand off, give the most specific stable target available (product
  deep link; GitHub install URL only when the URL/App slug is known; otherwise
  the console base URL plus a durable area like Settings / Integrations). Do not
  guess slugs or URLs, and do not expose tokens or secrets.
- If the human is not an admin, do not send them into an admin-only surface;
  involve the responsible admin or ask who should be brought in.

## No Repo Yet

If First Tree says no repo is connected:

1. Do not ask for GitHub App authorization first.
2. Ask for either a local project folder path or a GitHub repo URL.
3. Local project folder path → inspect it and give the evidence-backed menu.
4. GitHub URL → use host `gh` or local git credentials when available.
5. If `gh` is missing / unauthenticated / lacks access, explain that exact gap
   and ask for the narrowest recovery: local project folder path, GitHub CLI
   install, or `gh auth login` / account access.
6. Do not offer "Build your Context Tree" until there is readable code to draw it
   from and the human is a confirmed admin.

GitHub App authorization, repo authorization, Context Tree creation/binding, and
`gh repo create` all require explicit user consent. The user's pick in the menu
is that consent for tree build; other authorizations use a tracked ask. If the
user is not an admin, explain those are admin-owned and continue with local path
/ host `gh`.

## Role Guardrails

- **Admins** may be offered "Build your Context Tree" in the menu (Matrix row 6),
  and guided through GitHub App / repo selection when a chosen task needs durable
  platform capability.
- **Invitees / members** must NOT be offered tree build, team-repo selection, or
  GitHub App install, and must not mutate org-wide setup. Note that an admin owns
  those. This holds in EVERY state/row, not only the invitee rows in the matrix —
  if the role is invitee, the tree-build option is off the table regardless of
  which row matched.
- A GitHub URL alone is not a reason to ask for GitHub App installation — try
  host `gh` first.
- Private repo access depends on the member's local credentials. Do not promise
  access to named private repos until reads actually succeed.
- Authorization, repo creation, pushes, PR creation, and destructive actions
  require explicit user consent.

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
  option; accept free text.
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
