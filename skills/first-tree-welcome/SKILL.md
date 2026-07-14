---
name: first-tree-welcome
version: 1.2.1
description: Use for a First Tree onboarding first chat, especially natural opening messages like "welcome aboard", "Please help me get started with First Tree", or "Please help me get settled into this team on First Tree." Also covers the production-scan fix first chat ("fix the launch blockers found by my production readiness scan"). Do not use for dedicated tree setup chats, ordinary chats, PR reviews, repo scans, tree writes, or maintenance.
---

# First Tree Welcome

## Scope

Use this skill only when the chat is clearly the onboarding first chat created by
First Tree, including natural messages such as "welcome aboard", "Please help me
get started with First Tree", or "Please help me get settled into this team on
First Tree." Do not use it for ordinary chats, PR reviews, repo scans, tree
writes, or maintenance work.

Two look-alikes that are NOT this launcher, and one that routes by shape:

- **A dedicated tree-build / single-task chat** (you were placed in it, or it IS
  one) — run that task's own skill (`first-tree-seed` to build/seed a tree,
  `first-tree-read` / `first-tree-write` as appropriate), not this launcher flow.
- **A repo-scan chat** — it can open with the same "welcome aboard" line but then
  asks for a repository scan or readiness report; run its own bound scan skill.
- **A production-scan FIX chat** — the opening message references an
  already-completed scan ("fix the launch blockers found by my production
  readiness scan") with a `Repository:` line, plus a `Machine-readable
  findings: https://report.first-tree.ai/<key>.json` line when the report key
  survived the handoff. Nothing needs re-scanning — never look for a scan
  skill. This is the launcher for a pre-selected fix: once a readable findings
  source exists, handle the eligible blockers the way a normal first-task menu is
  fanned out — several eligible blockers become their own parallel fix chats, a
  single one is just fixed in place (see "Production-scan fix handoff" below).
  The onboarding greeting ("welcome aboard") only tells you the human's role
  for the later Context Tree offer; it does NOT change how you handle the fix.
  No readable findings source → ask for the report or a re-run, then stop.

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
a first-class item. "First-class" means a concrete, evidence-backed offer —
never a throwaway line, and never a wall of text; restraint is about not
offering setup in the wrong place, not about a weak offer in the right one.
Setup never preempts value: you always show understanding first, you never open
with setup, and the user always chooses.

Treat the opening message as the user's onboarding request. Reply naturally,
without exposing skill names or launch mechanics.

## You drive; the user doesn't do your thinking

You own moving this forward to the onboarding goal (the user feels real value,
and — for an admin — team setup progresses). When you hit a snag or something
unexpected: **diagnose the real cause, do what you can safely do yourself, and
put a question to the user only when it is genuinely theirs** — a product/scope
fork, consent for a consequential or irreversible action, or an input only they
can give (a credential, a repo, a login). When you must ask, ask **one** clear
question with your recommendation. Never hand the user a wall of options, a raw
error, a pile of diagnostics, or a mechanism choice that is yours to make. Read
`## Handling snags` below before reporting any failure.

## The Flow: read the state, then act

Before your first substantive reply, infer the onboarding state from the
start-chat message, runtime briefing, repo resources, Context Tree binding, and
available local files:

- **role**: admin, invitee, or unclear — read it from the onboarding greeting
  (see **Reading role from the greeting** below); the runtime gives you no other
  reliable role signal, so do not assume;
- **code repo**: connected/recommended, local path/URL provided, or none;
- **Context Tree**: no binding, bound-but-empty, bound-and-populated, or unknown
  — a mere binding does not imply a populated tree, and the tree you may have
  bound is not necessarily this team's; confirm state by reading the **target
  team's** tree (root `NODE.md`), not by trusting a binding;
- **host `gh` / `glab` / local credentials**: usable or not.

If state is unknown, first try to resolve it yourself (read the greeting for
role, attempt the repo read, check the host CLI (`gh` or `glab`); only if it stays genuinely
unresolvable, name the one specific missing piece and ask for that. Do not
invent repo access, GitHub/GitLab authorization, or tree readiness.

#### Reading role from the greeting

The onboarding greeting is role-distinct, and it is your **primary role signal**
— the runtime does not otherwise tell you whether the human is an admin. Read it
before deciding whether to offer any admin-only setup:

- **Admin** — "Please help me get started with First Tree" (a team owner
  starting their own team). A **production-scan fix** handoff that arrives **with
  the onboarding greeting** ("welcome aboard" + the scan-fix ask) is likewise the
  owner onboarding their own project → treat as admin for setup-gating.
- **Invitee / member** — "Please help me get settled into this team on First
  Tree" (joining a team someone else owns).
- **Unclear** — anything else: do not assume admin; treat admin-only setup as
  owned by an organization admin. This includes a **greeting-free** production-scan
  fix handoff (the direct quickstart fix path, which an already-onboarded
  invitee/member can reach) — do NOT offer admin-only setup (tree build, GitHub
  App install) there unless an actual admin signal is present.

This distinction is what gates admin-only setup (building the Context Tree,
installing the GitHub App, selecting team repos). It is deliberately the
**visible** greeting, not a hidden field, so the product's kickoff openers and
these examples are kept in sync by a test — do not paraphrase them loosely.

### Your first substantive reply

- **No readable code yet** — no repo connected, no local path, no GitHub/GitLab URL, and
  no readable team context. Make exactly one minimal ask: request one project
  entry point — a local project folder path on this machine or a GitHub/GitLab repo URL
  — without faking understanding. Recommended shape: "Share one project entry
  point: a local project folder path on this machine, or a GitHub/GitLab repo URL. I'll
  inspect it first, then suggest a few concrete starter tasks." If they share a
  GitHub URL, use host `gh` first; if they share a GitLab URL, use `glab` first.
  This ask is a legitimate first result. Do not ask for GitHub App authorization
  first, do not offer the first-task menu yet, and do not mention Context Tree
  setup yet.
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
3. **Fix the blockers — fan out only when there are several** (only with a
   readable findings source — see step 2). Triage the findings into eligible
   fix tasks. Eligible means the finding has concrete evidence in the report,
   still applies after checking the current repo state, and is safe/bounded and
   independently fixable (a scoped change with a clear check — add an index, add
   security headers, fix an N+1, add an error boundary). Production-scan normally
   reports 3-5 blockers, so this path should usually produce 3-5 parallel fix
   chats when those blockers are eligible. Then route by how many eligible
   blockers there are:
   - **Two or more** → this chat is the launcher: open up to 5 eligible blockers
     as active chats with `chat create` addressed to your own agent (see Spawning
     Task Chats), each with a **distinct, specific topic** naming that one fix
     (`Fix: N+1 in orders list`, `Fix: add security response headers`) —
     never reuse the launcher's own generic `Fix production scan blockers`
     title, which would collide with it. Two eligible blockers means two chats;
     do not split or invent work just to reach three. If an unusual report has
     more than five eligible blockers, start five active fix chats and list the
     rest as queued in this launcher. Keep THIS chat as the launcher/map, and say
     plainly which blockers you did not start.
   - **Exactly one eligible blocker** → do NOT fan out; fix it here, in this
     chat. A lone blocker has no parallelism to show, and a launcher plus a
     single child chat is pure overhead.
   - **None eligible to autofix** (everything left is a judgment call or stale)
     → spawn nothing; go straight to surfacing them (below).
   Do not split one blocker into implementation-step chats: code change, tests,
   verification, and PR for that blocker belong in the same spawned fix chat.
   **Never fan out — or autofix — a judgment call**: a finding that needs product, architecture, or security-design judgment (rate-limiting redesign,
   changing auth), lacks concrete evidence, no longer matches the current repo,
   or is already covered by existing code or an already-open PR. Surface those
   in this chat for the user to decide or acknowledge.
   Before any spawned fix starts changing code, verify the finding still applies
   against the current repo. If it is already fixed or covered by existing code
   or an already-open PR, report that and move to the next queued eligible
   blocker rather than producing a duplicate fix. Whether a fix runs in a
   spawned chat or here, its brief/target is self-contained: the repository URL,
   the findings JSON URL (when present), the specific finding(s) with their
   evidence and recommended fix, the instruction to verify the finding still
   applies before changing code, what to do when access is missing (diagnose the
   cause, then the single narrowest recovery — the narrowest GitHub access or a
   local path), and the completion bar — a verified fix or PR for that blocker,
   with evidence.
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
| No project yet (no repo/path/URL) | Ask for one local project folder path or a GitHub/GitLab repo URL. For GitHub URLs try host `gh` / local credentials first; for GitLab URLs try `glab` / local credentials first. Do not ask for GitHub authorization first, and do not offer tree build (no code to draw it from). |
| Repo/resource exists but local credentials cannot read it | **Diagnose why** (private repo needing access / `gh` or `glab` not authenticated / wrong path / network), then give the one specific next step for that cause — `gh auth login` or `glab auth login` if the matching CLI isn't authenticated; for a private repo, the narrowest access, an accessible URL, or a local project folder path; the corrected path if it's mistyped (see **Handling snags**). Do not claim private repo contents, fake understanding, or send a menu; don't just report the read failure and ask for a path/URL/credential all at once. |
| Repo readable, tree missing or empty | Show code value, then offer the menu. **For a confirmed admin**, the menu carries BOTH the value-task bundle AND "Build your Context Tree"; otherwise value tasks only. On selection, fan out. |
| Repo readable, tree already populated | Read both, cite concrete evidence, offer value-task options. Do NOT offer tree build (already built); do not seed the tree here. |
| Repo readable, tree state unknown | Give repo-based value; do not invent tree readiness. Offer tree build only once you can confirm the tree is missing/empty AND the human is an admin. |
| Any other state (catch-all) | Give evidence-backed value from whatever is readable; do not invent repo access or tree readiness. If nothing is actionable yet, first exhaust what you can safely check yourself, then ask for the one specific thing that unblocks you (see **Handling snags**). |

### Role overlay (holds in EVERY state above)

Role gates only admin-only setup (building the tree, selecting team repos,
installing the GitHub App), not value.

- **Invitee / member**: NEVER offered tree build, team-repo selection, or GitHub
  App install, and must not mutate org-wide setup — regardless of which state
  matched. Give value from whatever is readable; note that an admin owns/finishes
  team setup. On a not-ready team, offer a meet-the-agent / local-path path now.
- **Unclear**: first resolve role from the greeting (see **Reading role from the
  greeting**) — it usually resolves. Only if it stays genuinely unresolvable, do
  not assume admin: give value from whatever is readable, and note an admin owns
  team setup — don't walk a non-admin into an admin surface, and don't lead with
  "who should be involved?".

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
  (label e.g. "Start on these tasks", naming the 2–4 concrete tasks you found:
  checkout tests, the expired-session TODO…) plus **"Build your Context Tree"**.
  Give the tree option **immediate** weight, not only a future benefit: its
  first pass hands the user a reviewed map of their team's structure and key
  decisions **now** (the orientation an "explain the architecture" task gives,
  but captured as living memory, not a throwaway doc), reused by every future
  agent. Ground it in what you observed in *this* repo; if you'd otherwise offer
  an architecture-map task, fold it in here. **Render it to the user as one
  tight line**, e.g. "Build your Context Tree — your team's decisions mapped
  now, reused by every future agent." Bundling the value tasks keeps this a
  clean two-way choice; the user may pick either, both, or skip.
- **Recommend, don't just list, when the evidence warrants it.** If what you
  read makes the tree the higher-leverage first move (lots of undocumented
  cross-cutting decisions, a team about to grow, more agents incoming), say so
  in **one** honest sentence with the reason — still offering the value tasks,
  still the user's choice. Ordinary evidence → keep it a neutral one-line
  option. Never push where the role/tree gates don't hold.
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
- **Keep every user-facing line tight.** Each option is **one** punchy line;
  lead with the concrete value and stop — no walls of text, no stacked benefits.
  Users skim; a big block gets skipped.
- If there is no readable code yet, do not send this menu — get a project first.

Example shape:

```text
Your acme-dashboard is a Next.js app. app/checkout/recovery.ts has a TODO for
expired-session re-auth with no nearby test, and the routes/data flow isn't
documented yet.

What do you want to kick off? You can pick more than one — I'll run each in its
own chat so they progress in parallel.
- Start on these tasks: checkout tests + the expired-session TODO.
- Build your Context Tree: map your team's key decisions once — every future agent starts from them.

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

Once the user picks — or, for a production-scan fix launcher, once you have
triaged the eligible blockers (see "Production-scan fix handoff") — **do
not do the work in this launcher chat** (one exception: a scan-fix launcher with
**exactly one** eligible blocker fixes it in place, per that section). Fan the
selected work out into parallel chats — **one chat per task**: if the user picked
the value bundle, open one chat for EACH task in it; if they picked individual
value tasks, open one chat per picked task; if they picked the tree build, open
one chat for it; for a scan-fix launcher with **two or more** eligible blockers,
open one chat per blocker, up to five active fix chats, with a distinct,
fix-specific topic. (That per-task
parallelism is the leverage the user is meant to feel.) Open each with:

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
  lint, screenshot, doc diff). If the task's likely completion artifact is a PR,
  include that the task should follow the PR and report whether live tracking is
  active or blocked by missing GitHub App coverage.
- **For "Build your Context Tree"**: the brief is user-visible, so write it in
  plain product language and **name no skill in it** — e.g. "Build our team's
  Context Tree from the connected code — propose an initial structure for me to
  review, then fill it in." Also include one implementation detail for the
  woken agent, after the user-visible task sentence: when it creates a new
  Context Repo on GitHub, apply the seed workflow's GitHub governance setup with
  host `gh`, including a working Code Owner mapping and default-branch rules. If
  that automatic GitHub governance setup fails, tell the user it failed and list
  the manual settings to add. When you are woken in that chat, recognize the
  tree-build task and load `first-tree-seed` from the task itself; it resolves
  the tree's state and owns creating + binding + seeding — this launcher does
  none of that.
- Give each chat a clear, stable topic.

Then, back in THIS launcher chat, post a short line naming the chats you opened
so the user can see the parallel streams. As each spawned chat produces a result
(a PR, a passing test, the seed PRs), note it here so the launcher stays the
map of what is in flight.

### After a value PR opens: guide App install once

A review-ready PR gives the admin a concrete reason to install or update First
Tree GitHub App coverage: CI results, review comments, and merge state can flow
back into chat. The welcome launcher owns one concise install/coverage guidance
at this moment; do not rely only on the generic PR-following failure text that a
spawned task may have shown.

- The spawned value task owns following its PR in its own task chat
  (`first-tree github follow <url>`) and reporting whether live tracking is
  active or blocked by missing GitHub App coverage. The launcher cannot follow a
  PR "in" another chat; it consumes the task result and explains the user-facing
  consequence.
- If tracking is active, say only that the task chat will track the PR. Do **not**
  add App-install guidance.
- If tracking is blocked because the First Tree GitHub App is not installed on,
  or does not cover, the GitHub account/repo that owns the PR, and the human is a
  confirmed **admin**, include one launcher-level install/coverage line when you
  report that PR result. Keep it tied to the win, for example: "PR is open. To
  have CI, review comments, and merge updates flow back here, install or cover
  this repo from Settings -> GitHub." Use a product link only when you have a
  stable one; otherwise name **Settings -> GitHub**. Do not fabricate raw GitHub
  App install URLs.
- If the human is an invitee/member or role is unclear, do not route them into
  an admin-only install surface. Say an organization admin can enable live PR
  updates for this repo if useful.
- Give this App-install guidance at most once in the onboarding launcher. If the
  spawned task chat already mentioned the missing App, still include the short
  launcher-level line; do not repeat a full setup explanation.

## After value lands: the one-time tree offer

Delivering value is the moment the user is most open to the durable next step —
building the team's Context Tree — so do not let the chance pass just because it
was not picked up front. Offer it **once**, after value, on these conditions:

- Only if the user did **not** already pick "Build your Context Tree" from the
  first-task menu (and did not already decline it). If they picked it, it is
  already running — never re-offer.
- Only when the same setup gates still hold: the human is an **admin** (per
  **Reading role from the greeting**) and the team's Context Tree is still
  **missing or empty** (confirm by reading the target team's tree, not by
  trusting a binding).
- **Trigger on the first verified result** — the moment a value task returns
  something the user can see work, whether it ran in a spawned chat or was fixed
  in place (a passing test, a review-ready PR, a
  shipped doc), tie the offer to that win — not after everything finishes, and
  not before the first win.
- **When the evidence warrants it** (per **Recommend, don't just list**), make
  this a reasoned recommendation, not a neutral question — e.g. "Test's green.
  So much here isn't written down — want me to build your Context Tree next? You
  get the map now; every agent reuses it." Ordinary evidence → one plain line.
- Offer it **once**, tight (one or two short sentences). If they say no or
  later, drop it — no repeated nudging. Never for an invitee, and never when the
  tree is already populated.
- On "yes", spawn the dedicated tree chat as in **Spawning Task Chats** — never
  create, bind, or seed inline in this launcher.

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

## Handling snags

When a step fails or the situation is unexpected, do not relay the symptom and
stop. Find the real cause, take the smallest forward action yourself, and ask
the user only for what only they can supply.

- **Diagnose to the cause, not the symptom.** "Can't read the repo" is a
  symptom; the cause is one of — a private repo needing access, `gh` or `glab` not
  authenticated, a mistyped path, a network issue. Name the actual cause and act
  on *that*.
- **Exhaust what you can safely do before asking.** Retry the specific safe
  action, try the obvious alternative (host `gh` or `glab`, a local path), read what you
  can. Escalate to the user only when you hit something only they can supply
  (access, a credential, a login, a repo) or a genuine decision.
- **When you do ask, make it specific and small.** "`gh` isn't logged in — run
  `gh auth login`, then tell me" or "`glab` isn't logged in — run `glab auth
  login`, then tell me" beats "I couldn't read it; give me a path, URL, or
  credentials." One concrete next step, not a menu of possibilities.
- Never expose raw errors or internal mechanics; say the cause and the next step
  in plain terms, tight.

This does **not** loosen consent: a consequential or irreversible action (repo
creation, pushes, PRs, authorization) still needs the user's explicit yes. Being
a protagonist is about owning diagnosis, safe/reversible steps, and mechanism
choices — not about acting on things that are genuinely the user's to allow.

## Guardrails, Consent & Setup Handoff

**Consent gates.** Authorization, repo authorization, Context Tree
creation/binding, `gh` / `glab` repo create, pushes, PR/MR creation, and destructive actions
all require explicit user consent. The user's pick in the menu IS that consent
for tree build; other authorizations use a tracked ask.

**Role.**

- **Admins** may be offered "Build your Context Tree" (tree missing/empty, after
  value), and guided through GitHub App / repo selection when a chosen task needs
  durable platform capability.
- **Invitees / members** must NOT be offered tree build, team-repo selection, or
  GitHub App install, and must not mutate org-wide setup — in every state. Note
  an admin owns those.
- **Unclear role**: resolve it from the greeting first (see **Reading role from
  the greeting**); only if genuinely unresolvable, do not assume admin — note an
  admin owns setup rather than routing a possible non-admin into an admin
  surface, and don't lead with "who should be involved?".

**GitHub / repo access.**

- Prefer a local project folder path + the matching host CLI (`gh` for GitHub,
  `glab` for GitLab) for ordinary forge work. A GitHub URL alone is not a reason
  to ask for GitHub App installation — try host `gh` first; a GitLab URL should
  try `glab` first.
- Private repo access depends on the member's local credentials. Do not promise
  access to named private repos until reads actually succeed.
- If First Tree says no repo is connected: (1) do not ask for GitHub App
  authorization first; (2) ask for either a local project folder path or a GitHub/GitLab
  repo URL; (3) local path → inspect it and give the evidence-backed menu;
  (4) GitHub URL → use host `gh` or local git credentials when available; GitLab
  URL → use `glab` or local git credentials when available; (5) if `gh` or
  `glab` is missing / unauthenticated / lacks access, explain that exact gap and
  give the single narrowest recovery for that diagnosed cause (e.g. `gh auth
  login` or `glab auth login` when it's just unauthenticated; a local project
  folder path; the relevant CLI install) — one concrete step, not the whole menu;
  (6) do not offer "Build your Context Tree" until there is readable code and
  the human is a confirmed admin.

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

- You drive to the goal. On a snag, diagnose the real cause and take the safe
  forward action yourself; ask the user only for a genuine fork, consent for a
  consequential/irreversible action, or an input only they can give — as one
  question with your recommendation. Never dump options, a raw error, or a
  mechanism choice that is yours to make (see **You drive** / **Handling snags**).
- Read before claiming understanding; use concrete evidence, not generic prose.
- Lead with value understanding; never open with setup.
- Determine the human's role from the onboarding greeting (see **Reading role
  from the greeting**) — the admin opener "get started with First Tree" vs the
  invitee opener "get settled into this team". This is your only reliable role
  signal; do not silently omit an admin's setup options just because no
  structured role field exists.
- Offer "Build your Context Tree" ONLY to an admin whose team tree is
  missing/empty, and only after showing value — never to an invitee, never when
  the tree is already populated. Pushing it anywhere else — to look proactive, or
  because setup is on your mind — is the eager-setup instinct: block it.
- If the admin did not pick the tree up front, re-offer it exactly once when the
  first value task delivers a verified result (see **After value lands**) — tied
  to that win, one line, no repeated nudging.
- When the first value result is a PR/MR, consume the task chat's follow/tracking
  status and, only for a confirmed admin when App coverage is missing, surface
  the one-time App-install guidance from **After a value PR opens** in this
  launcher. This does not replace the tree offer; if both apply, keep each to a
  short sentence and do not repeat either later.
- Present choices as a multi-select ask with **2–4 options** — the value tasks
  bundled with the tree-build option when tree build is offered, otherwise the
  value tasks listed individually; never a one-option ask; no "Skip for now"
  option; accept free text. (When there is only one responsible next step, skip
  the ask — recommend it in a normal reply.)
- Fan selected work out into separate chats via `chat create --to <self>`; do not
  do the selected work in this launcher chat. (Exception: a production-scan fix
  launcher with exactly one eligible blocker fixes it in place — see
  Production-scan fix handoff.)
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
