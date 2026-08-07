---
name: first-tree-welcome
version: 1.4.0
description: Use for a First Tree onboarding first chat, especially natural opening messages like "welcome aboard", "Please help me get started with First Tree", or "Please help me get settled into this team on First Tree." Also covers the production-scan fix first chat ("fix the launch blockers found by my production readiness scan"). Do not use for dedicated tree setup chats, ordinary chats, PR/MR reviews, repo scans, tree writes, or maintenance.
---

# First Tree Welcome

## Scope

Use this skill only when the chat is clearly the onboarding first chat created by
First Tree, including natural messages such as "welcome aboard", "Please help me
get started with First Tree", or "Please help me get settled into this team on
First Tree." Do not use it for ordinary chats, PR/MR reviews, repo scans, tree
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
  source exists, route by blocker count — several eligible blockers become their own fix chats, a
  single one is just fixed in place (see "Production-scan fix handoff" below).
  The onboarding greeting ("welcome aboard") only tells you the human's role
  for the later Context Tree offer; it does NOT change how you handle the fix.
  No readable findings source → ask for the report or a re-run, then stop.

## What This Is

Make the first work loop immediate and reviewable:

1. **Connect one real project** — use only the project entry the user supplied.
2. **Show it is readable** — take a bounded look and return a two-sentence
   project receipt, without pretending that receipt is product value.
3. **Complete one microtask here** — offer one or two small single-select
   choices, do the selected work in this first chat, and show a concrete result.
4. **Bridge once** — after the result, offer only the one next step that follows
   directly from it. Setup is never the price of starting work.

This chat is **value-first, visible, and consent-gated**. It is not a launcher
for the first task and it is not a parallel-work demo. Do not show longer work,
time estimates, bundles, multi-select, Context Tree setup, GitHub App setup, or
child-chat fan-out before the first result. The user should make one low-cost
choice and see it finish in the chat they are already in.

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
- **detected source forge**: GitHub, GitLab, another host, or unknown — derive
  it from the supplied URL or the repository's `origin` remote;
- **matching host CLI / local credentials**: `gh` for GitHub, `glab` for
  GitLab, or plain `git` for another host; usable or not.

If state is unknown, first try to resolve it yourself (read the greeting for
role, attempt the repo read, check the host CLI, `gh` or `glab`); only if it
stays genuinely unresolvable, name the one specific missing piece and ask for
that. Do not
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

- **No readable code yet** — no repo connected, no local path, no Git repository URL, and
  no readable team context. Make exactly one minimal ask: request one project
  entry point — prefer a local project folder path on this machine, or accept a
  Git repository URL — without faking understanding. Recommended shape: "Share
  the local project folder path on this machine; if it is not local, send the Git
  repository URL instead. I'll read a small slice, then give you one or two
  concrete ways to start." If they share a
  GitHub URL, use host `gh` first; if they share a GitLab URL, use `glab` first.
  This is project intake, not a value result. Do not scan the machine for other
   directories, do not ask for GitHub App authorization first, do not offer a
   task yet, and do not mention Context Tree
   setup yet. This input is required to continue, so deliver the minimal request
   with `first-tree chat ask <human> "<local-path-first request>"` and no option
   menu; do not leave it only in console/final narration.
- **Readable code available** — a repo is connected and you can read it, or a
  local path / URL was given and you can read it. (A repo that is connected but
  local credentials cannot read it is the "cannot read it" state below — report
  the read failure, do not fake understanding or send a menu.) Your first
  substantive reply must:
   1. Use the existing working/status channel to say you are taking a small look
      at the project. Do not add a new status mechanism.
   2. Follow **Bounded project read** below; do not audit or recursively scan.
   3. Send the two-sentence project receipt, then offer one or two single-select
      microtasks and accept a free-text task.

  Do not mention Context Tree or forge setup merely because you observed its
  state. The project receipt proves access only; the selected microtask produces
  the first result.

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
   verification, and PR/MR for that blocker belong in the same spawned fix chat.
   **Never fan out — or autofix — a judgment call**: a finding that needs product, architecture, or security-design judgment (rate-limiting redesign,
   changing auth), lacks concrete evidence, no longer matches the current repo,
   or is already covered by existing code or an already-open PR/MR. Surface those
   in this chat for the user to decide or acknowledge.
   Before any spawned fix starts changing code, verify the finding still applies
   against the current repo. If it is already fixed or covered by existing code
   or an already-open PR/MR, report that and move to the next queued eligible
   blocker rather than producing a duplicate fix. Whether a fix runs in a
   spawned chat or here, its brief/target is self-contained: the repository URL,
   the findings JSON URL (when present), the specific finding(s) with their
   evidence and recommended fix, the instruction to verify the finding still
   applies before changing code, what to do when access is missing (diagnose the
   cause, then the single narrowest recovery — the narrowest forge access or a
   local path), and the completion bar — a verified fix or PR/MR for that blocker,
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
| No project yet (no repo/path/URL) | Ask for one local project folder path or a Git repository URL. For GitHub URLs try host `gh` / local credentials first; for GitLab URLs try `glab` / local credentials first; for another host use plain `git`. Do not ask for GitHub authorization first, and do not offer tree build (no code to draw it from). |
| Repo/resource exists but local credentials cannot read it | **Diagnose why** (private repo needing access / `gh` or `glab` not authenticated / wrong path / network), then give the one specific next step for that cause — `gh auth login` or `glab auth login` if the matching CLI isn't authenticated; for a private repo, the narrowest access, an accessible URL, or a local project folder path; the corrected path if it's mistyped (see **Handling snags**). Do not claim private repo contents, fake understanding, or send a menu; don't just report the read failure and ask for a path/URL/credential all at once. |
| Repo readable, tree missing or empty | Take the bounded project read, send the receipt, and offer one or two microtasks without setup. Resolve tree details only if the post-result bridge could legitimately be a Context Tree task. |
| Repo readable, tree already populated | Use relevant tree context only when already available, but keep the project read bounded and offer one or two microtasks. Do not turn tree state into a setup or Review prompt. |
| Repo readable, tree state unknown | Use repo evidence for the receipt and microtask choice without inventing tree readiness. Resolve tree state only if a later result makes it relevant. |
| Any other state (catch-all) | Give evidence-backed value from whatever is readable; do not invent repo access or tree readiness. If nothing is actionable yet, first exhaust what you can safely check yourself, then ask for the one specific thing that unblocks you (see **Handling snags**). |

### Role overlay (holds in EVERY state above)

Role gates only post-result admin setup (building the tree, selecting team repos,
installing the GitHub App), not project intake or the first microtask.

- **Invitee / member**: NEVER offered tree build, team-repo selection, or GitHub
  App install, and must not mutate org-wide setup — regardless of which state
  matched. Give value from whatever is readable; note that an admin owns/finishes
  team setup. On a not-ready team, offer a meet-the-agent / local-path path now.
- **Unclear**: first resolve role from the greeting (see **Reading role from the
  greeting**) — it usually resolves. Only if it stays genuinely unresolvable, do
  not assume admin: give value from whatever is readable, and note an admin owns
  team setup — don't walk a non-admin into an admin surface, and don't lead with
  "who should be involved?".

You do not create or bind the tree yourself in this chat. When the user accepts
the later, qualified "Build your Context Tree" bridge, SPAWN a dedicated chat and let
`first-tree-seed` own repo creation, binding, and seeding there (see Spawning
Task Chats). Never silently create, bind, or duplicate team-wide setup from this
launcher chat.

## The First In-Chat Work Loop

Use the normal file or stdin transport for every multi-line or Markdown
`chat ask` / `chat send` body. Do not inline rich text through the shell.

### Bounded project read

Before the first choice, read only enough to make the choice specific:

- the README or equivalent top-level project description;
- one manifest or build descriptor;
- the first-level directory structure;
- one relevant entry point;
- at most one nearby test or TODO.

Stop when those surfaces establish the stack, project shape, and one credible
starting point. Do not use recursive directory scans, whole-repo symbol dumps,
broad audits, machine-wide directory discovery, or additional files merely to
make the receipt sound richer. Choose the entry point from a path named by the
README, manifest, or first-level structure; do not enumerate inside a
subdirectory to discover more candidates. Before the choice, do not follow the
entry point's imports or search for its callers; that evidence belongs to the
selected microtask. A first-level listing may inspect the repository root only;
do not run `rg`, `find`, `tree`, or an equivalent search against a subdirectory.
Read only the path or repository URL the user provided. Before the read, use the existing chat status/description channel —
`first-tree chat update --description "<brief working status>"` — to say that
you are taking this small look. Do not substitute console narration or invent a
UI state or orchestration protocol.

### Two-sentence project receipt

After the bounded read, write exactly two short sentences before the choices:

1. what you successfully read — project type/stack plus the concrete files or
   entry point;
2. where a useful first microtask can start and why that seam is credible.

This is an access receipt, not a value result. Do not label it a win, finding,
audit, recommendation, or completed task.
The receipt must be in the user-visible delivery that contains the choice. For
a two-option tracked ask, put both receipt sentences at the start of the ask
body; do not leave them only in working narration or a non-delivered final.

### One microtask choice

Offer **1–2 single-select microtasks** and allow a free-text task. At least one
option is read-only: a focused understanding or verification task that returns
a concrete judgment with evidence or a 5–8 step call chain. A second option may
be a minimal local change only when all three are clear from the bounded read:
the target, the exact change surface, and one focused verification command.

When there are two options, use a tracked ask without `--multi-select`. When
only one responsible option exists, recommend it in a normal reply because the
tracked request primitive does not accept one option; deliver that reply with
`first-tree chat send <human>`. Accept a free-text task in either shape. Do not
show time ranges, longer tasks, bundles, collaboration
claims, or a parallel child-chat menu. Do not include Context Tree, GitHub App,
or repository setup in the first choice.

For two options, pass `--options` a JSON array of two objects with concise
`label` and `description` fields. The body remains in the `-F` file; do not
search the user's project for chat CLI examples.

### First result in this chat

Do the first selected microtask in this chat. Do not use `chat create` for the first selection,
even if the user chooses the minimal local change. Before a
write, treat the selection as consent only for the explicitly described local
change; it is not consent to push, create a PR/MR, install anything, or write
the Context Tree.

The selected option already establishes the starting seam. Begin from that
agreed entry and follow only task-relevant direct references; do not repeat
repository discovery or use a recursive scan to reconstruct the menu. Do not
run `rg`, `find`, `tree`, or an equivalent search over the repository or one of
its subtrees; open the agreed entry and the exact paths named by its direct
imports, calls, adjacent test, or verification command.

Return exactly one reviewable result shape:

- a concrete judgment with file/line or command evidence;
- a 5–8 step call chain with file references; or
- a minimal diff plus the focused check and its actual result.

The result must be useful without another task chat. Keep it scoped to the
selected microtask and do not silently continue into a larger fix.

### One relevant bridge

After the result, add exactly one next-step question, directly related to that
result. The answer controls the next action, so put the complete result and the
one question together in a tracked `first-tree chat ask <human>` body; do not
leave the result or bridge only in console/final narration:

- ask the bridge as one free-text question without `--options` or another
  choice menu;

- if the result contains a diff, ask whether to create its PR/MR; do not mention
  GitHub App yet;
- after a PR exists, mention GitHub App coverage only when live CI, review, or
  merge tracking is actually needed and unavailable;
- offer a separate Context Tree chat only when the human is a confirmed admin,
  the tree is missing/empty, and the result exposed a lasting cross-module
  decision that future work must reuse;
- otherwise bridge to one adjacent verification or implementation step.

Never stack PR, GitHub App, Context Tree, repository registration, or another
task as simultaneous bridges. The session project is not automatically added
to the long-term Team repository catalog.

Example shape:

```text
I read the Next.js manifest and the recovery entry point in app/checkout/recovery.ts.
Its expired-session branch is a credible first seam because it has a focused nearby test command.

Choose one:
- Trace expired-session recovery and return a 5–8 step call chain with file references. (read-only)
- Add the one missing recovery test and run its focused test command. (local change)

Or type a different microtask.
```

## Spawning Task Chats (later only)

The first microtask never fans out. Only after the user explicitly asks for multiple larger tasks
may you use independent chats, one per task, with the
existing status and completion contract. Do not present later fan-out as the
first menu or describe it as multi-agent collaboration when it is only separate
work streams.

Two other paths may still create task chats: a user accepts the qualified
post-result Context Tree bridge, or a production-scan fix launcher has two or
more eligible blockers. Production-scan fan-out remains capped at five active
fix chats with distinct topics. Open each later task with:

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
  own. Do NOT write a terse pointer like "do task 1". For later larger tasks,
  include these explicit fields:
  - **Goal** — the bounded user outcome and scope;
  - **Context** — repository URL or local path, relevant files/evidence, and
    the agreed scope;
  - **Deliverable** — the inspectable result the user will receive;
  - **Verification** — the independent command, evidence, or acceptance check;
  - **Progress communication** — keep the existing chat status
    current with `chat update --description`, then send the ordinary completion message
    with outcome and evidence.
- **Do not invent a second orchestration or progress protocol.** Task chats use
  the existing chat status/description and completion message; the launcher is
  only the map and entry point.
- **For a value task**: the brief states the work and its verification (test,
  lint, screenshot, doc diff, or read-only evidence report). If the likely completion artifact is a PR/MR,
  choose the review CLI from that repository's remote. For a GitHub PR, include
  that the task should run `first-tree github follow` and report whether live
  tracking is active or blocked by missing GitHub App coverage. For a GitLab MR,
  include that the task should run `first-tree gitlab follow <url>` after
  creation or reuse and report the returned pending or active attention state.
  GitLab attention is inbound-only; only a pending declaration waits for the
  next matching valid webhook. A follow failure does not invalidate the MR;
  report only the First Tree chat attention gap. Never substitute `first-tree
  github follow` or GitHub App setup guidance for GitLab.
- **For "Build your Context Tree"**: the brief is user-visible, so write it in
  plain product language and **name no skill in it** — e.g. "Build our team's
  Context Tree from the connected code — propose an initial structure for me to
  review, then fill it in. Open the Structure PR/MR first. After that milestone,
  preserve any existing Reviewer; if none is selected, guide me to use this same
  Agent as the default and enable Automatic Review in Settings → Getting Started. Draft
  the initial content, but do not open its PR/MR until a selected Reviewer is
  enabled so that PR/MR can exercise Automatic Review." This explicit
  Reviewer-handoff sentence is part of the brief only for the admin tree-build
  path launched here; it lets the dedicated task preserve the contract across
  Phase 1 and Phase 2 without guessing from chat provenance. When you are woken
  in that chat, recognize the tree-build task and load `first-tree-seed` from
  the task itself; it resolves the tree's state and owns creating + binding +
  seeding — this launcher does none of that.
- Give each chat a clear, stable topic.

Then, back in THIS chat, post a short line naming the later chats you opened
so the user can see the parallel streams. As each spawned chat produces a result
(a PR/MR, a passing test, the seed PRs/MRs), note it here so the launcher stays the
map of what is in flight.

### After a value PR/MR opens

A first-result diff does not authorize a PR/MR. Ask whether to create it as the
single post-result bridge. If the user agrees, create and follow the PR/MR in
this chat, then report the result. Do not move this step into a child chat.

A review-ready GitHub PR makes App coverage relevant only when live CI, review,
or merge updates are genuinely useful and following the PR reports that coverage
is missing. In that state, a confirmed admin may receive one concise coverage
handoff. Do not mention the App before the PR exists or merely because the
repository is hosted on GitHub.

This section's App-install guidance is GitHub-only. For a GitLab MR, do not call
`first-tree github follow`, send the user to **Settings → Getting Started** for GitHub App
installation, or imply
that the First Tree GitHub App is involved. Instead, use the
`first-tree gitlab follow <url>` result and preserve its returned pending or
active state. GitLab attention is inbound-only; explain the webhook wait only
when the declaration is pending. If that follow fails, report only the First
Tree chat attention gap; the failure does not invalidate the MR. Do not invent
a GitLab integration URL or settings target.
Never substitute `first-tree github follow` or GitHub App setup guidance for GitLab.

- This chat follows the PR (`first-tree github follow <url>`) and reports whether
  live tracking is active or blocked by missing GitHub App coverage.
- If tracking is active, say only that this chat will track the PR. Do **not**
  add App-install guidance.
- If tracking is blocked because the First Tree GitHub App is not installed on,
  or does not cover, the GitHub account/repo that owns the PR, and the human is a
  confirmed **admin**, summarize that live updates are waiting on the admin
  action surfaced after the follow result. Do not stack it with another bridge.
- If the human is an invitee/member or role is unclear, do not route them into
  an admin-only install surface. Say an organization admin can enable live PR
  updates for this repo if useful.
- If the task result did not establish whether tracking is active or blocked,
  report only the PR result. Do not infer App debt.

## After value lands: the qualified tree bridge

Delivering value is the moment the user is most open to the durable next step —
building the team's Context Tree. Offer it **once**, after value, on these
conditions:

- The first microtask choice never included tree setup. If the user already received
  and declined this later offer, never re-offer it.
- Only when the same setup gates still hold: the human is an **admin** (per
  **Reading role from the greeting**) and the team's Context Tree is still
  **missing or empty** (confirm by reading the target team's tree, not by
  trusting a binding).
- Only when the verified result exposed a lasting decision that crosses module
  boundaries and future work needs to reuse. A routine trace, local finding,
  test result, or small diff does not qualify.
- If the result includes a diff, the PR/MR question takes priority as the only
  bridge; do not add the tree offer beside it.
- Offer it **once**, tight (one short question tied to the observed decision).
  If they say no or
  later, drop it — no repeated nudging. Never for an invitee, and never when the
  tree is already populated.
- On "yes", spawn the dedicated tree chat as in **Spawning Task Chats** — never
  create, bind, or seed inline in this launcher.

## No other first-result setup

Do not inspect or surface Automatic Review, Team repository registration, or
other setup after the first result. Those capabilities may become relevant in a
later dedicated work stream, but they are not alternate onboarding bridges. A
dedicated tree task owns its own later Review handoff; this chat does not repeat
it.

## Doing the Work & Talking to the User

Lead with the result, be brief, say only what helps the user act next. Do not
narrate process, and do not surface this skill's internals (the state table,
skill names like `first-tree-seed`, "binding", "kickoff", "systemSender") — say
it in plain product terms or not at all. Do not claim; show.

For the first microtask, the onboarding payoff is that the user *sees* it work
in this chat:

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
creation, pushes, PRs/MRs, authorization) still needs the user's explicit yes. Being
a protagonist is about owning diagnosis, safe/reversible steps, and mechanism
choices — not about acting on things that are genuinely the user's to allow.

## Guardrails, Consent & Setup Handoff

**Consent gates.** Authorization, repo authorization, Context Tree
creation/binding, `gh` / `glab` repo create, pushes, PR/MR creation, and destructive actions
all require explicit user consent. The user's acceptance of the later,
contextual tree offer IS consent to open its dedicated task chat; other
authorizations use a tracked ask.

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

**Forge / repo access.**

- Prefer a local project folder path + the matching host CLI (`gh` for GitHub,
  `glab` for GitLab) for ordinary forge work. A GitHub URL alone is not a reason
  to ask for GitHub App installation — try host `gh` first; a GitLab URL should
  try `glab` first.
- Private repo access depends on the member's local credentials. Do not promise
  access to named private repos until reads actually succeed.
- If First Tree says no repo is connected: (1) do not ask for GitHub App
  authorization first; (2) ask for either a local project folder path or a Git repository
  URL; (3) local path → inspect it and give the evidence-backed menu;
  (4) GitHub URL → use host `gh` or local git credentials when available; GitLab
  URL → use `glab` or local git credentials when available; (5) if `gh` or
  `glab` is missing / unauthenticated / lacks access, explain that exact gap and
  give the single narrowest recovery for that diagnosed cause (e.g. `gh auth
  login` or `glab auth login` when it's just unauthenticated; a local project
  folder path; the relevant CLI install) — one concrete step, not the whole menu;
  (6) do not offer "Build your Context Tree" until there is readable code and
  the human is a confirmed admin.

**Setup handoff (steps you cannot perform — durable provider authorization,
repository coverage, Review Agent selection).** Raise them only when a real
milestone makes the capability relevant, then
guide that one step to completion — do not raise setup as an opening menu, and do
not give brittle click-by-click paths. When you do hand off, give the most
specific stable target available (product deep link when authoritative;
otherwise **Settings → Getting Started**). Do not guess slugs or URLs, and do not expose
tokens or secrets. If the human is not an admin, do not send them into an
admin-only surface; involve the responsible admin.

## Hard Rules

- You drive to the goal. On a snag, diagnose the real cause and take the safe
  forward action yourself; ask the user only for a genuine fork, consent for a
  consequential/irreversible action, or an input only they can give — as one
  question with your recommendation. Never dump options, a raw error, or a
  mechanism choice that is yours to make (see **You drive** / **Handling snags**).
- Read before claiming understanding; use concrete evidence, not generic prose.
- Lead with concrete project understanding; never open with setup.
- Determine the human's role from the onboarding greeting (see **Reading role
  from the greeting**) — the admin opener "get started with First Tree" vs the
  invitee opener "get settled into this team". This is your only reliable role
  signal; do not silently omit an admin's setup options just because no
  structured role field exists.
- Offer "Build your Context Tree" ONLY after the first verified result, when it
  exposed a lasting cross-module decision, the human is a confirmed admin, and
  the team tree is missing/empty. Never put it in the first choice, offer it to
  an invitee, or stack it beside another bridge. A routine trace, local finding,
  test result, or small diff does not qualify.
- A first-result diff makes the PR/MR consent question the one bridge. Only
  after the user authorizes creation and live GitHub PR tracking reports missing
  coverage does the GitHub App become relevant. GitLab uses
  `first-tree gitlab follow <url>` in this chat and preserves the returned
  pending or active state; never substitute GitHub App setup.
- Do not inspect or surface Automatic Review, Team repository registration, or
  other setup after the first result. The first chat does not automatically
  register the session project as a durable Team repository. A later dedicated
  tree task owns any setup its own PR/MR actually needs.
- Present **1–2 single-select microtasks** grounded in the bounded read and
  accept a free-text task. At least one option is read-only. Offer a minimal
  local mutation only when its target, change surface, and focused verification
  are all clear. Do not show time ranges, longer tasks, bundles, setup, or a
  multi-select control.
- Put the two-sentence project receipt in the same user-visible delivery as the
  first choice, and use `chat update --description` for the bounded-read status.
  Console narration does not satisfy either user-visible obligation.
- Deliver required project intake and every post-result bridge through one
  tracked `chat ask`; deliver a one-option first choice through `chat send` and
  a two-option choice through one tracked ask without `--multi-select`.
- Do the first selected microtask in this chat. Do not use `chat create` for the
  first selection. Only after the user explicitly asks for multiple larger
  tasks may those later tasks fan out through the existing task-chat workflow.
  (Exception: the separate production-scan fix route retains its blocker
  orchestration — see Production-scan fix handoff.)
- Every spawned chat's opening message is a self-contained task brief with Goal,
  Context, Deliverable, Verification, and Progress communication, because it is
  all the context the woken agent has and it reads as if the user sent it. Long
  tasks reuse chat status/description and the ordinary completion message.
- Do not create, bind, or seed the Context Tree in this launcher chat —
  `first-tree-seed` owns that in the spawned tree chat.
- Finish each task against its own check and show the evidence; never claim it
  works without verifying.
- Do not perform authorization, repo creation, pushes, or PR/MR creation without
  explicit consent.
- Do not surface skill internals or jargon to the user.
- Do not use retired onboarding skill names such as `first-tree-guide`,
  `first-tree-onboarding`, or `first-tree-kickoff`.
