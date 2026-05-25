# New-User Onboarding Redesign — Design Doc

**Status:** Implemented in PR #248 with **amendments** (§13), then the UI delivery was **superseded** — see the banner below before relying on any section.
**Branch:** `feat/onboarding-redesign`
**Scope:** Hosted Hub (first-tree.ai) post-signup onboarding for brand-new users.
**Out of scope:** Local self-hosted onboarding (`first-tree start`) — covered in [docs/onboarding-redesign.md](onboarding-redesign.md). NewAgentDialog rewrite — covered in PR #237.

> ⚠️ **ARCHITECTURE SUPERSEDED (2026-05).** This doc specifies onboarding as an
> **inline** experience — a stepper above `CenterPanel`, `OnboardingView` bodies,
> Step 3 reusing the workspace `ChatView` in place. That architecture has been
> **retired**. Onboarding now ships as a **standalone, full-screen `/onboarding`
> route** ([packages/web/src/pages/onboarding/](../packages/web/src/pages/onboarding/));
> the workspace root redirects unfinished users into it via `shouldEnterOnboarding`
> (`pages/onboarding/steps.ts`).
>
> Read accordingly:
> - **Obsolete (UI architecture only):** §4 (inline layout / `OnboardingView` /
>   stepper-above-CenterPanel) and §7.1–§7.4 (Step 3 sub-state UI). The components
>   it names (`onboarding-view`, `onboarding-stepper`, `step1/2/3` bodies,
>   `step-frame`) have been deleted and no longer exist.
> - **Still authoritative (product + server semantics):** §5 (team auto-naming,
>   incl. §5.5), §6 (agent creation), §7.5–§7.6 + the bootstrap message, §8
>   (completion model — `onboarding_dismissed_at` / `onboarding_completed_at`),
>   §9. Source comments cite these section anchors, so the numbering is kept stable.

---

## 1. Why

This redesign **expands the product scope of onboarding**, not just the UI. Old onboarding is "connect a computer + create an agent" (the existing `OnboardingView` covers exactly those two server states). New onboarding is the **complete configuration ceremony for the first-tree product system**: set up your team + create your first agent (with repo binding) + initialize the Context Tree.

The three steps are **parallel pillars, not levels of importance** — each configures one of the foundational concepts users must have for the product to work as designed:

| Step | Configures | Without it, the product is… |
|---|---|---|
| 1 — Team | The collaborative space agents and people share | Agents are unanchored; future invitees have no team identity to join |
| 2 — Agent | An AI bound to a specific source repo, running on a specific machine | No way for AI to act on your code |
| 3 — Context Tree | The shared knowledge layer (NODE.md / members / AGENTS.md / source-binding metadata) that gives the agent durable context and enables auto-sync | Just an agent that chats — equivalent to a generic Claude Code session, missing first-tree's core value: context that grows with code |

In old scope, Step 1 was implicit (auto-created at OAuth, invisible) and Step 3 was outside onboarding (users could leave with a chatting-but-context-less agent). New scope makes both **first-class steps** because they're structurally essential to the product, not optional extras.

The original `OnboardingView` (since retired — see the banner above) reflected the old scope: a single-page form that conflated agent name + computer connect + runtime choice. It had no path for team confirmation, no repo binding, and no path to tree initialization.

Goals of the redesign:
1. **Expand onboarding scope** to cover the full first-tree setup ceremony (team / agent / tree), reflecting the product's actual value chain — not just "an agent that chats"
2. Multi-step structure that mirrors the user's mental model and gives each scope element a dedicated, finishable step
3. Reuse `ChatView` for the tree-init step instead of re-implementing chat inside the onboarding
4. Persistent visual progress indicator so users know how far they are
5. Keep server-side state model minimal — extend only with `users.onboarding_dismissed_at`; rename the existing `wizardStep` field to `onboardingStep` (see §8.5)
6. **Leave room to grow** — Step 1 is intentionally minimal in v1 (rename the auto-named team) but reserves a slot for future team setup (description, icon, invite teammates, team type, defaults). See §5.6.

---

## 2. Scope of this doc

### In scope

Three onboarding steps for a brand-new user signing in via GitHub OAuth on the hosted Hub:

1. **Create team** — auto-named, one-click confirm
2. **Create first agent** — name + GitHub source repo + computer + runtime
3. **Init context-tree** — chat with the freshly-created agent; the agent runs `first-tree tree init` locally

### Out of scope (deferred)

- **Step 4 — Configure GitHub Automation.** Originally part of the onboarding. Deferred because: (a) the github-automation product positioning is unsettled (first-tree-automation is in limbo, repo-gardener is paused per atf-launch ROADMAP); (b) it's a long-tail feature whose value isn't felt in the first 5 minutes; (c) gating workspace entry on a 3-5 minute external setup hurts conversion. See §10 for the deferred decisions.
- **Local self-hosted onboarding.** Covered in [onboarding-redesign.md](onboarding-redesign.md).
- **Invite-flow variant** (`joinPath === "invite"`). The current OnboardingView already differentiates "you've joined {team}" vs "Welcome to First Tree Hub". Invite users skip Step 1 (they're joining an existing team), but the rest of the flow is identical. Detailed invite path edge cases are a separate follow-up.

---

## 3. Audience and assumptions

**Q1 settled:** Hub's hosted onboarding targets **developers only** at this stage.

Concrete assumptions:
- User can open a terminal, run `npm install -g`, and `gh auth login` is a familiar command
- User has a GitHub account (login is GitHub OAuth)
- User has a source repository on GitHub they want to wire first-tree into
- User is comfortable reviewing PRs and merging them on GitHub

**Non-developer accommodation** (e.g., macOS `.pkg` installer, browser-only flow) is **explicitly deferred** until product reaches that audience.

---

## 4. Architecture

> **Superseded:** this section describes the retired *inline* layout. The shipped
> flow is the standalone `/onboarding` route — see
> [packages/web/src/pages/onboarding/](../packages/web/src/pages/onboarding/)
> (`onboarding-shell.tsx` chrome, `progress-rail.tsx` stepper, `steps.ts` gating).
> Kept for historical rationale only.

### 4.1 Layout — stepper above CenterPanel only (not above rail)

The onboarding's progress indicator is a **stepper that lives above CenterPanel only**, occupying the same horizontal extent as CenterPanel. It does **not** span the left rail. The rail keeps its full vertical real estate during onboarding.

```
WorkspaceLayout (app shell)
  ├── Top global chrome  (logo, user menu, org switcher)
  │
  ├── Left rail          │  ◉ Onboarding Stepper                          ← only above CenterPanel
  │  (agents/chats)      │   Create team · Connect agent · Init context-tree   (rail above stays clean)
  │                      ├─────────────────────────────────────────
  │                      │  CenterPanel (routes — see §4.3)
  │                      │
```

**Step labels (stepper + body title, kept identical for consistency):**
- Step 1: `Create team`
- Step 2: `Connect agent`
- Step 3: `Init context-tree` (`init` short verb intentional — matches `first-tree tree init` CLI; `context-tree` hyphenated as a single term identifier)

The stepper persists across **every** CenterPanel mode during onboarding. The user can switch between OnboardingView (Steps 1, 2, and Step 3 intro) and ChatView (Step 3's actual chat) without losing the stepper.

**Why above CenterPanel only, not full-width:**
- The stepper conveys progress for what's happening in **CenterPanel**'s content (Step 1/2 forms, Step 3 chat). Anchoring it directly above that column makes the visual coupling explicit.
- The left rail shows agent / chats lists — it has no semantic relationship to the onboarding. Compressing the rail's top to make room for a onboarding indicator is unjustified visual cost.
- When the user dismisses the stepper, only CenterPanel's column shifts up by a row; the rail is unaffected. Steadier than a full-width row collapsing.

### 4.2 OnboardingView — single component, branched body

`OnboardingView` is **not** the onboarding's only view. It is a wrapper used for the **non-chat** parts of the onboarding. Its body branches on `onboardingStep`:

```
OnboardingView body:
  step 1                        → Step1Body (team form)
  step 2                        → Step2Body (agent form)
  step 3, no chat created yet   → Step3IntroBody (intro card)
  step 3, chat exists           → does NOT render
                                  (CenterPanel routes to ChatByIdView instead)
```

Stepper is **not** part of `OnboardingView` — it lives at the layout level (positioned above CenterPanel per §4.1, not inside OnboardingView's render output).

### 4.3 CenterPanel routing

The existing CenterPanel router ([packages/web/src/pages/workspace/center/index.tsx](../packages/web/src/pages/workspace/center/index.tsx)) needs one priority change:

```
selectedChatId === draft           → NewChatDraft
selectedChatId set                 → ChatByIdView          ← Step 3 chat lands here, unwrapped
onboardingStep !== "completed"         → OnboardingView        ← Steps 1, 2, Step 3 intro
nothing                            → NoChatView
```

**Critical:** `selectedChatId set` takes priority over `onboardingStep !== completed`. Once the user clicks "Yes, set it up" in Step 3 IntroBody, a chat is created and `?c=<chatId>` lands in the URL. From that moment on, the user is in `ChatByIdView` rendering the **plain unwrapped `ChatView`** — no overlay, no onboarding chrome injected into the chat itself. The stepper at the top is the only signal they're still in onboarding.

### 4.4 Step transitions

All step transitions are **user-driven** via stepper clicks. There is no auto-advance. The stepper enforces:
- Click any **completed** step → revisit (URL changes, OnboardingView body switches)
- Click the **current** step → no-op
- Click any **future** step → blocked (visually marked unavailable)

Stepper clicks PATCH `onboardingStep` server-side and update the URL.

### 4.5 left rail behavior

**Decision (O-2): rail renders normally throughout onboarding.**

- Steps 1–2: rail is empty (user has no agent or chat yet) — that's fine, no special UI needed
- After Step 2 creates the agent: rail naturally has 1 agent entry
- After Step 3 creates a chat: rail naturally has 1 chat entry under that agent
- Onboarding-completion moment: workspace looks "lived-in" because user organically populated the rail through their setup actions

Why not hide / gray-out:
- Hiding causes a "extra column suddenly appears" visual jump when onboarding completes
- Graying-out is a common onboarding anti-pattern — shows the user a UI surface they explicitly cannot use
- A user who clicks a rail item mid-Step 3 (e.g. revisit a chat) is still in their workspace, not breaking out of a tutorial. Onboarding here is guidance, not a sandbox.

### 4.6 Stepper visual states

Each step in the stepper has 4 visual states. Connection lines between adjacent steps follow a derived rule.

**Per-step states:**

| State | Visual | Meaning |
|---|---|---|
| **Pending** | `○` outline circle, 1px muted-gray border, label muted-gray | User has not reached this step yet |
| **Active** | `●` filled circle, accent fill, 1.5px accent border, optional ~8% accent halo (no animation), label fg-1 semi-bold | The step the user is currently on |
| **Completed** | `✓` check icon (white) inside an accent-filled circle, label fg-2 (slightly de-emphasized), `cursor: pointer` on hover with subtle label underline | Done; clickable to revisit |
| **Error** | `⊗` cross icon inside state-error filled circle, state-error label | Reserved for Step 2 client-never-online edge case; other steps don't have predictable error states |

**Connection-line rule** (one line between every adjacent pair):

- Both ends are "achieved" (Completed or Active) → solid 1.5px accent
- Either end is Pending → dashed 1px muted, dash 4px

**Examples:**

```
Stage A — Just entered Step 1:
   ●   ┄┄┄┄┄┄┄   ○   ┄┄┄┄┄┄┄   ○                              [✕]
   Create team    Connect agent    Init context-tree

Stage B — Step 1 done, on Step 2:
   ✓   ━━━━━━━   ●   ┄┄┄┄┄┄┄   ○                              [✕]
   Create team    Connect agent    Init context-tree

Stage C — Step 1+2 done, on Step 3:
   ✓   ━━━━━━━   ✓   ━━━━━━━   ●                              [✕]
   Create team    Connect agent    Init context-tree

Stage D — Step 2 client never came online (error):
   ✓   ━━━━━━━   ⊗   ┄┄┄┄┄┄┄   ○                              [✕]
   Create team    Connect agent    Init context-tree
```

**Stepper layout details:**

- Circle-to-line gap: 4px on each side (line does not visually connect into the circle's edge — keeps stepper as a "discrete step" expression rather than a progress fill)
- Active state's halo (8% accent opacity ring around the filled circle) is **static, not pulsing** — pulsing animation in stepper position competes for attention with body content
- Completed circle keeps the same diameter as Pending and Active (visual stability across state transitions)

**Dismiss button (`✕`):**

Position: anchored to the **right end of the stepper row**, vertically center-aligned with the circles. It's outside the step circles' horizontal extent, so the line between Step 3 and `✕` is just dead space (no connecting line, no "step 4" visual).

Click `✕` → PATCH `users.onboarding_dismissed_at = NOW()` → stepper unmounts → workspace renders normally. A toast appears (`"Setup hidden — resume any time in Settings → Setup"`, with an `Open settings` action) so the user has a discoverable way back.

Hover state: cursor `pointer`, button background lightens slightly. Tooltip on hover: `Hide setup steps`. The button is **disabled** until `onboardingStep === "completed"` — letting users hide the stepper before Step 2 is done lands them on an empty workspace with no guidance for "what now?".

The dismiss action is **reversible** via `Settings → Setup → Resume setup` (built v1; same `restoreOnboarding` action that PATCHes `dismissed_at = NULL`). The Settings entry mirrors the stepper `✕` gate exactly — both require `onboardingStep === "completed"` to hide; both surface the same toast on dismiss.

---

## 5. Step 1 — Create team

### 5.1 User journey

1. User signs in via GitHub OAuth → server's `completeOauthFlow` ([api/auth/github.ts:142](../packages/server/src/api/auth/github.ts:142)) auto-creates a personal team using `createPersonalTeam` ([services/membership.ts:116](../packages/server/src/services/membership.ts:116))
   - **Default displayName: `{login}'s team`** (e.g., `gandyxiong's team`) — see §5.5 for the rationale and the change required
   - Slug: derived from `profile.login` (unchanged)
2. Browser lands on `/`, OnboardingView renders Step 1 body
3. User sees their auto-named team in a single editable input (focused, cursor at end)
4. User presses Enter or clicks Continue → onboardingStep advances to step 2

**Decision (O-3): show the form with the pre-filled value, focus the input, Enter or Continue advances.** Users who don't care: 1 keystroke (Enter). Users who want to rename: edit + Enter. No skip-the-step shortcut, no auto-advance — Step 1 is on the stepper, it should be visible.

### 5.2 Body / wireframe

```
┌─────────────────────────────────────────────────────────────────────┐
│  ●━━━━━━━━━━━━━━━━━━━○━━━━━━━━━━━━━━━━━━━○                  [✕]    │
│  Create team    Connect agent     Init context-tree                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│                       Create team                                   │
│                                                                     │
│        ┌─────────────────────────────────────────────┐              │
│        │ Team name                                   │              │
│        │   ┌───────────────────────────────────────┐ │              │
│        │   │ gandyxiong's team                     │ │              │
│        │   └───────────────────────────────────────┘ │              │
│        │   You can rename your team later.           │              │
│        │                                             │              │
│        │                            [ Continue → ]   │              │
│        └─────────────────────────────────────────────┘              │
└─────────────────────────────────────────────────────────────────────┘
```

### 5.3 Behavior

**User-facing semantic:** Step 1 IS team creation. The user picks the name, clicks Continue, and their team identity is set. That's how the stepper labels it (`Create team`) and how it should feel.

**Implementation detail:** the DB rows are pre-inserted at the OAuth callback (`completeOauthFlow` calls `createPersonalTeam`) so JWT issuance has org context immediately. Step 1's Continue then either:
- Confirms the default value as-is → no rename API needed; just advances `onboardingStep` to `step2`
- Sends the edited name → `PATCH organizations.displayName`, then advances `onboardingStep`

This DB-ahead-of-UI pattern keeps OAuth + JWT issuance simple at v1 cost: any user who OAuths but abandons before Step 1 leaves an "orphan team" row that's never user-confirmed. Cleanup is a periodic background job. Funnel analytics relies on client-side telemetry events (Step 1 form mounted / Step 1 Continue clicked) since server cannot distinguish "team auto-created but never confirmed" from "team confirmed by user".

If the orphan-row count or analytics fidelity becomes a problem, v1.1 may refactor to "create team only at Step 1 Continue" (requires user-only JWT, see §12 Phase 1.5 follow-up).

### 5.4 Slug handling — single field, slug derives silently

**Decision (P-2): Step 1 form shows only the team's `displayName`. The slug (used in URLs and @mentions) is auto-derived from `profile.login` and not visible to the user.** Reason: Step 1 needs to be the lightest possible. Surfacing slug as an editable field invites a decision the new user cannot make confidently. If a user later wants to rename the slug, that lives in team settings post-onboarding.

### 5.5 Default team name change

The current `completeOauthFlow` at [api/auth/github.ts:200-205](../packages/server/src/api/auth/github.ts:200) passes:

```typescript
const personal = await createPersonalTeam(app.db, {
  userId,
  loginSeed: profile.login,
  userDisplayName: profile.displayName?.trim() || profile.login,  // ← change this
});
```

Result today: team displayName is literally the user's GitHub display name (e.g., `Gandy Xiong`), which reads as a person's name, not a team. Awkward when the user later invites collaborators.

**Change:** pass `userDisplayName: \`${profile.login}'s team\`` instead. New team displays as `gandyxiong's team`, matches Linear convention, makes "this is a collective space" obvious from the start.

The underlying schema and slug logic don't change. Only the value passed at the OAuth callback. ~1-line server change in [api/auth/github.ts](../packages/server/src/api/auth/github.ts).

### 5.6 Growth path — Step 1 is a reserved expansion slot

**v1 (this redesign): Step 1 is minimal.** Single input (team name) + Continue. Rename if you care, otherwise one keystroke and you're past it.

**Future versions** are expected to expand Step 1 into a richer team-setup surface. Possibilities (not committed; listed for design awareness):

- **Team description** — short blurb shown in invite emails, dashboards
- **Team icon / avatar** — visual identity in the org switcher and rail
- **Team type** — personal / company / open-source-project, drives default permissions
- **Invite teammates** — early collaboration setup (email or GitHub-handle invites)
- **Default privacy / visibility** — public-facing team page yes/no
- **Time zone, working hours** — for future scheduling features

Why this matters for the v1 design: keeping Step 1 in the wizard structure (even though v1 only does rename) **preserves the slot** for these expansions. If we collapsed Step 1 in v1 (e.g., made it auto-skip), every future addition would require re-introducing a wizard step, re-doing stepper visuals, re-routing — high churn cost. v1's "minimal but real" framing is a deliberate investment.

**Implementation guidance:** Step1Body is structured as a vertical form with one field today. Adding fields later means appending to the same component, not introducing new wizard steps. The CenterPanel routing stays unchanged across Step 1 expansions.

---

## 6. Step 2 — Create first agent

### 6.1 User journey

1. User lands on Step 2 from clicking Continue on Step 1
2. Form has 3 required inputs:
   - **Agent name** (display name, free text)
   - **Source repository** (GitHub repo picker — populated from user's accessible repos via OAuth)
   - **Computer** (CLI command box; user runs `first-tree login <token>` on their machine)
3. Runtime auto-picks first available `ok` capability (Claude Code preferred); user has no choice in Step 2 (advanced option deferred to post-onboarding settings)
4. User clicks Create → server creates the agent with `gitRepos: [{url: <selected repo>}]` + clientId + runtime → polls until agent is online → advances `onboardingStep = step3`

### 6.2 Body / wireframe

```
┌─────────────────────────────────────────────────────────────────────┐
│  ✓━━━━━━━━━━━━━━━━━━━●━━━━━━━━━━━━━━━━━━━○                  [✕]    │
│  Create team    Connect agent     Init context-tree                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│                       Connect agent                                 │
│                                                                     │
│        ┌─────────────────────────────────────────────┐              │
│        │ 1. Name                                     │              │
│        │    ┌──────────────────────────────────┐     │              │
│        │    │ Code Reviewer                    │     │              │
│        │    └──────────────────────────────────┘     │              │
│        │                                             │              │
│        │ 2. Repository it works on                   │              │
│        │    ┌──────────────────────────────────┐     │              │
│        │    │ ▾ gandyxiong/first-tree      │     │              │
│        │    └──────────────────────────────────┘     │              │
│        │    (picker, listed via GitHub OAuth)        │              │
│        │                                             │              │
│        │ 3. Computer it runs on                      │              │
│        │    ╭─ Waiting for your computer… ──────╮    │              │
│        │    │ Open Terminal and run:            │    │              │
│        │    │   first-tree login 9f3a… 📋 │    │              │
│        │    ╰───────────────────────────────────╯    │              │
│        │    (flips to ✓ <hostname> connected         │              │
│        │     when client connects)                   │              │
│        │                                             │              │
│        │                             [ Connect  → ]  │              │
│        └─────────────────────────────────────────────┘              │
└─────────────────────────────────────────────────────────────────────┘
```

### 6.3 GitHub repo picker

**Decision (Q-2.A): use a GitHub OAuth-driven picker, not free-text URL input.** Reasons:
- User already paid the OAuth cost at login — reusing the access is cheap
- "Pick from a list" is a discrete action, lighter than typing a URL
- The list itself educates the user ("these are the repos this agent could touch")
- Step 4 (when it returns) and any future GitHub-touching feature can reuse this picker component

**Implementation note:** the current GitHub OAuth scope is `read:user user:email` ([api/auth/github.ts:69](../packages/server/src/api/auth/github.ts:69)). Listing repos requires `repo` scope.

**Decision (O-1): expand login OAuth scope to `read:user user:email repo` from day 1.** Every signed-in user grants repo access at signup; picker works immediately at Step 2 with no extra redirects. Trade-off: GitHub's authorization page lists "Read and write access to code, issues, pull requests..." which can feel heavy for users who haven't decided to build an agent yet. Mitigated by product copy ("We never push without your explicit ask — every change goes through a PR you review").

Why not `public_repo`-only fallback: target audience is developers, who mostly work in private repos. A picker that lists empty (because user has no public repos) is a worse onboarding experience than a one-time broader scope ask.

Why not deferred / per-step incremental upgrade: a second GitHub redirect mid-onboarding adds friction at exactly the wrong moment (user about to create their first agent). Front-loading the ask at signup is less disruptive even though more users grant repo access "without needing to."

### 6.4 Computer connection

Same mechanism the retired inline view used (now in the standalone flow's [`use-computer-connection.ts`](../packages/web/src/pages/onboarding/use-computer-connection.ts)):
- Lazy-mint a connect token on Step 2 mount
- Display `npm install -g first-tree && first-tree login <token>`
- Poll `listClients()` every 3s; flip from "Waiting" pulsing dot to "✓ <hostname> connected" pill when a client comes online
- Once connected, fetch capabilities to confirm at least one runtime is `ok`

### 6.5 Runtime auto-pick

**Decision (P-3): no runtime UI for first-time onboarding. Runtime is auto-selected.**

- Pick first `ok` runtime in priority order: `claude-code` first, then `codex`
- If neither is `ok`, show an actionable hint per [PR #237's runtime hint copy](https://github.com/agent-team-foundation/first-tree/pull/237) (`Install Claude Code on the host first` / `Run \`claude\` to sign in`)
- The "Powered by" runtime chip UI from current `OnboardingView` is **removed** in this redesign — first-time users don't see runtime as a decision

Rationale: new users don't know the distinction between Claude Code and Codex; surfacing two equally-named engines invites a decision they can't make confidently. They can change runtime in agent settings post-onboarding. Multi-runtime UI lives in the post-onboarding `NewAgentDialog` (where the user is making a deliberate "create another agent" choice and may have a preference).

### 6.6 Create action

On `[Create]`:
1. POST `/admin/agents` with `{type: "personal_assistant", displayName, name (slug), clientId, runtimeProvider, gitRepos: [{url: <selected repo>}], organizationId}`
2. Poll `/admin/agents/<uuid>/client-status` until online (30s timeout, retry UI per current OnboardingView)
3. On online: PATCH `onboardingStep = step3`, navigate to `/` (Step 3 intro)

Note: `gitRepos` materialization is automatic on first chat session start (see [packages/client/src/handlers/claude-code.ts:682-700](../packages/client/src/handlers/claude-code.ts:682)) — `git worktree add` clones the source repo into the agent's session cwd before any user message is processed.

---

## 7. Step 3 — Init context-tree

### 7.1 The two sub-states

Step 3 has **two visually distinct states** (down from three — sub-state A' was retired in favour of a unified server-side dismiss; see §8.3):

**Sub-state A: no chat created, onboarding not dismissed** → `OnboardingView` renders `Step3IntroBody` (intro card with [Yes, set it up] / [I'll do it later])
**Sub-state B: chat exists** → `ChatByIdView` renders the plain unwrapped `ChatView`

Transitions:
- A → B: user clicks [Yes, set it up] in IntroBody. Server creates chat, frontend navigates to `?c=<chatId>`. The handler also PATCHes `onboarding_dismissed_at = NOW()` so the stepper unmounts above the new chat (no orphan onboarding chrome above real work).
- A → (dismissed): user clicks [I'll do it later] (or `✕` on the stepper). Both paths PATCH `onboarding_dismissed_at = NOW()` and surface the same toast (§8.3); workspace falls through to `NoChatView`.

The previously per-tab "intro dismissed" flag is gone — there is one server-side flag (`onboarding_dismissed_at`) and three triggers that all set it. Recovery is `Settings → Setup → Resume setup`.

### 7.2 Sub-state A — Step3IntroBody wireframe

```
┌─────────────────────────────────────────────────────────────────────┐
│  ✓━━━━━━━━━━━━━━━━━━━✓━━━━━━━━━━━━━━━━━━━●                  [✕]    │
│  Create team    Connect agent     Init context-tree                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│      ╭─ Init context-tree ────────────────────────╮                 │
│      │                                           │                  │
│      │  Your agent @code-reviewer is ready on    │                  │
│      │  gandy-mac and has cloned                 │                  │
│      │  gandyxiong/first-tree.               │                  │
│      │                                           │                  │
│      │  Set up first-tree on it now? It takes    │                  │
│      │  ~2 minutes — agent does the scaffolding, │                  │
│      │  you confirm a couple of choices.         │                  │
│      │                                           │                  │
│      │  ┌─ What this does ────────────────────╮  │                  │
│      │  │ • Creates a sibling tree repo and   │  │                  │
│      │  │   scaffolds it                      │  │                  │
│      │  │ • Installs the first-tree skill in  │  │                  │
│      │  │   both repos                        │  │                  │
│      │  │ • Writes binding metadata           │  │                  │
│      │  ╰─────────────────────────────────────╯  │                  │
│      │                                           │                  │
│      │      [ Yes, set it up ]                   │                  │
│      │      [ I'll do it later ]                 │                  │
│      ╰───────────────────────────────────────────╯                  │
└─────────────────────────────────────────────────────────────────────┘
```

### 7.3 Click [Yes, set it up] → A → B transition

```
1. POST /admin/agents/<uuid>/chats   → { chatId }
2. POST /admin/chats/<chatId>/messages
   body: BOOTSTRAP_MESSAGE  (see below)
3. navigate("/?c=<chatId>")          → URL changes
4. CenterPanel re-routes to ChatByIdView (selectedChatId set)
5. ChatView mounts; messages list shows the bootstrap user message + agent's streaming response
```

**Bootstrap message text** (verbatim, single source of truth shared with PR #237 and any other first-tree install trigger):

```
Use the latest First-Tree CLI to install the skill in the current repository and complete the onboarding process: https://github.com/agent-team-foundation/first-tree
```

Why this text and not something shorter:
- At this moment the agent does NOT have the first-tree skill loaded — installing it is precisely what Step 3 does. The agent must self-bootstrap knowledge of (a) which CLI to use, (b) the action to take, (c) the URL to consult if uncertain.
- A concise alternative like `Initialize first-tree for this repo.` is ambiguous to a knowledge-empty agent — `initialize` could be read as `git init`; `first-tree` may not be recognized as a specific tool.
- Reusing the same string across all entry points (PR #237's auto-send, this onboarding's button-driven send, future re-install flows) makes the agent's behavior predictable and centralizes prompt iteration.

The bootstrap message is the **only** Hub-injected interaction in Step 3. From that point on, agent and user converse freely.

### 7.4 Sub-state B — ChatView (plain, unwrapped)

> **Superseded (UI delivery only):** the kickoff no longer renders inside the
> workspace `ChatView` behind a persistent stepper. The standalone flow sends the
> bootstrap message, then navigates to `/?c=<chatId>` to drop the user into their
> first real chat (`pages/onboarding/steps/step-kickoff.tsx`). The **bind-tree
> "Path B"** that `org bind-tree` refers to is unchanged: the agent still
> creates/binds a context-tree repo and the Hub records it in org settings.

The user is in **the same ChatView** they'll use post-onboarding. No onboarding chrome inside. The stepper at the top of the workspace shell is the only "you're still in onboarding" signal.

Conversation flow (from research on [first-tree skill onboarding.md](https://github.com/agent-team-foundation/first-tree/blob/main/skills/first-tree/references/onboarding.md)):
- Agent runs `first-tree tree inspect --json` (auto, non-interactive)
- Agent asks **one question** based on inspect output: "Do you already have a Context Tree, or should I create a new one?"
- User replies (free-form chat or quick-reply chips, see Q-3.B)
- Agent runs `first-tree tree init` (auto)
- Agent prints `.first-tree/progress.md` content as a markdown checklist
- Agent offers to walk through manual tasks (NODE.md owners, members/, AGENTS.md guidance)
- Conversation continues at the user's pace

### 7.5 Step 3 → onboarding completion

**No "Continue to next step" button.** With Step 4 deferred, Step 3 is the final step. Onboarding completes via one of:

- **Implicit (recommended):** server-side `inferOnboardingStep` continues to return "completed" once user has both client + agent (current logic). Step 3's progress is **not server-tracked** — but this is a technical limitation (server can't observe local file system changes the agent makes), not a product judgment that Step 3 is less important than Steps 1–2. Step 3 is structurally essential; it just gets driven and tracked client-side.
- **User-initiated explicit:** Stepper has an "✕" dismiss button. Clicking it PATCHes `users.onboarding_dismissed_at = NOW()`. Stepper unmounts. workspace becomes the default chat-first form.

The two are **complementary**. Server-side completion is automatic. The dismiss button only handles the case where the user wants the stepper out of the way before/regardless of completing Step 3.

### 7.6 Step 3 specific decisions

**Q-3.A — Where does the bootstrap message come from?**
- (1) Hub injects (sessionStorage flag → ChatView mount → auto-send) — same mechanism as PR #237's First-Tree bootstrap
- (2) User clicks `[Yes, set it up]`, frontend explicitly calls `sendMessage()` with the bootstrap text

**Decision: (2)** — direct send on button click. No sessionStorage roundtrip. Cleaner, no chance of re-fire on tab reopen.

**Q-3.B — Does the agent's "existing tree?" question get a quick-reply chip UI, or is it free-form chat?**
- (1) Inline quick-reply chips below the message: `[Create a new one]` / `[I have one — paste URL]`
- (2) Free-form typing only

**Decision: (1)** — chips for the discrete-choice question; falls back to typing for the URL input.

**Q-3.C — How does the agent get into Step 3's chat with the right cwd?**

Already settled by Step 2's `gitRepos` binding. The agent's runtime spawns Claude Code with cwd = `<workspaceRoot>/workspaces/<chatId>`, and the `prepareGitWorktrees` step ([handlers/claude-code.ts:687-697](../packages/client/src/handlers/claude-code.ts:687)) materializes the source repo at `<cwd>/<localPath>` before the LLM runs. So when agent gets the bootstrap message, it's already in the user's repo.

---

## 8. Onboarding completion model

**Decision (O-7, plan C): stepper visibility is fully decoupled from `onboardingStep`. Stepper shows iff the user has not explicitly dismissed it. `onboardingStep` is informational only — it tells `OnboardingView` which body to render.**

### 8.1 Why decoupling is necessary

`inferOnboardingStep` in [api/me.ts:304-322](../packages/server/src/api/me.ts:304) flips to `"completed"` the moment the user has BOTH a connected client AND an agent — which happens at the end of Step 2. If stepper visibility were tied to `onboardingStep !== "completed"`, the stepper would unmount as soon as Step 2 finishes — and the user would land in Step 3 chat with no visible onboarding chrome.

Step 3 (tree init) is **not** server-tracked. There is no observable server-side fact that distinguishes "user completed Step 3" from "user is in Step 3 chat" from "user never engaged with Step 3". Forcing `onboardingStep` to encode Step 3's state would require a new RPC for Hub to read the agent's local file system (to check for `.first-tree/source.json`) — undesirable scope expansion that breaches the Hub-skill boundary.

Plan C sidesteps this entirely: keep `onboardingStep` doing exactly what it does today (server-inferred from `clients` + `agents`), and use a **separate client-driven dismiss flag** to control whether the stepper is on screen.

### 8.2 The two state mechanisms, side by side

**`onboardingStep` (server-inferred, existing logic, unchanged):**
- No `clients` row → `"connect"`
- Has client, no agent → `"create_agent"`
- Both → `"completed"`
- **Used for:** OnboardingView's body branching (which step's form to show). When onboardingStep is `"connect"` show Step1Body; `"create_agent"` show Step2Body; `"completed"` show Step3IntroBody (or its placeholder if dismissed). When the user clicks a stepper step to revisit, the URL changes and `OnboardingView` infers which body to render from URL state, not from server `onboardingStep` alone.

**`users.onboarding_dismissed_at` (new column, client-driven):**
- `NULL` → stepper renders
- timestamp → stepper does not render
- **Set by:** user clicking the `✕` on the stepper. Single PATCH, irreversible from UI v1.
- **Used for:** stepper visibility — and ONLY stepper visibility. Does not affect routing or body branching.

### 8.3 What this means in practice

- After Step 2 completes, `onboardingStep` server-side returns `"completed"`. Stepper still renders because `dismissed_at IS NULL`. Step 3 IntroBody renders in OnboardingView body.
- User clicks **[Yes, set it up]** → chat created, frontend navigates to `?c=<chatId>`. The same handler PATCHes `dismissed_at = NOW()` so the stepper unmounts immediately — the new chat is the workspace's primary surface and onboarding chrome above it is just noise.
- User clicks **[I'll do it later]** → PATCH `dismissed_at = NOW()`. Same as `✕`. CenterPanel falls through to `NoChatView`.
- User clicks **`✕`** on stepper → PATCH `dismissed_at = NOW()`. Same.
- All three dismissal paths surface a toast: `"Setup hidden — resume any time in Settings → Setup"` with an `Open settings` action that navigates to `/settings/setup`. (Exception: the [Yes, set it up] success path skips the toast — the user is mid-success entering their first chat, so the "Setup hidden" nudge would be noise.)
- Next time user logs in: `dismissed_at` is set → no stepper. Workspace is the chat-first default. User finds their agent and chats freely.
- Recovery: `/settings/setup` exposes a `Resume setup` button that PATCHes `dismissed_at = NULL`. The page also gates `Hide setup guide` on `onboardingStep === "completed"` — same gate the stepper `✕` uses.

### 8.4 Schema change required

```sql
ALTER TABLE users ADD COLUMN onboarding_dismissed_at TIMESTAMPTZ NULL;
```

A small Drizzle migration. The column is the **only** server-side state addition this redesign requires.

### 8.5 Naming: `wizardStep` → `onboardingStep` rename

This redesign **renames** the existing `wizardStep` field to `onboardingStep` for consistency with the rest of the codebase (`OnboardingView`, `users.onboarding_dismissed_at`, `onboarding-flags.ts` are all "onboarding"-named). Affected:

| Old | New | Where |
|---|---|---|
| `wizardStep` (field) | `onboardingStep` | server response, client state, tests |
| `inferWizardStep()` | `inferOnboardingStep()` | [packages/server/src/api/me.ts](../packages/server/src/api/me.ts) |
| `wizard.step` (API path) | `onboarding.step` | response shape from `/me` |

**Server values are NOT renamed.** The enum `"connect" | "create_agent" | "completed"` describes inferable facts (presence of `clients` row, `agents` row), not UI step numbers. **Mapping from server enum to UI Step is N-to-many, not 1-to-1:**

| `onboardingStep` value | Maps to UI… |
|---|---|
| `"connect"` | UI Step 2, sub-state "needs to connect a computer" |
| `"create_agent"` | UI Step 2, sub-state "has computer, needs to create agent" |
| `"completed"` | UI Step 1 + 2 done; user may be on UI Step 3 (not server-tracked) or have dismissed onboarding |
| (no value) | UI Step 1 has no server value because OAuth always pre-creates the team |

**Why not align values with UI Step numbers** (e.g., `"awaiting_step2_client"` / `"awaiting_step2_agent"` / `"step3_or_done"`): the server's enum describes facts the server can observe; the UI Step number is a frontend product concept. Renaming values to UI-aligned names would couple two different abstractions and lose information — the server cannot distinguish UI Step 3 from "user dismissed onboarding" using these values alone, that's an intentional asymmetry. Keep values as-is.

**Disambiguation across the doc:**
- "UI Step N" / "Step 1" / "Step 2" / "Step 3" (capitalized, with number) = the user-visible 3-step flow
- `onboardingStep` value (e.g. `"connect"`) = server-side enum, in code-quoted form
- "stepper" = the UI component above CenterPanel; "stepper position" / "stepper step" = a visual circle in that component (1-to-1 with UI Step)

**Migration scope:** ~30 occurrences across server + web + tests. Land in same PR as Phase 1.

---

## 9. State transitions summary

```
┌─────────────────────────────────────────────────────────────────┐
│ Server `inferOnboardingStep` (existing logic, unchanged):           │
│                                                                 │
│   no clients row     → "connect"      (Step 1 or 2 incomplete) │
│   has client, no ag. → "create_agent" (Step 2 incomplete)      │
│   both               → "completed"                              │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ Layout-level rendering of stepper (decoupled from onboardingStep):  │
│                                                                 │
│   users.onboarding_dismissed_at IS NULL                         │
│      → render stepper above CenterPanel                         │
│   else                                                          │
│      → no stepper                                               │
│                                                                 │
│ Stepper's "current step" highlight is computed client-side from │
│ onboardingStep + URL: if URL has ?c=<chatId> → step 3 active;       │
│ else use onboardingStep ("connect"→1, "create_agent"→2,             │
│ "completed"→3).                                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ CenterPanel router (priority order):                            │
│                                                                 │
│   selectedChatId === draft        → NewChatDraft                │
│   selectedChatId set              → ChatByIdView                │
│   onboardingStep !== "completed"      → OnboardingView              │
│   else                            → NoChatView                  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ OnboardingView body (branches on onboardingStep + chat existence): │
│                                                                 │
│   onboardingStep == "connect" + no client       → Step1Body         │
│      (auto-named team confirm)                                  │
│   onboardingStep == "create_agent"               → Step2Body        │
│      (agent form: name + repo + computer)                       │
│   onboardingStep == "completed" + no chat shown → Step3IntroBody    │
│      (intro card; click Yes creates chat)                       │
│   onboardingStep == "completed" + chat selected → (does not render; │
│                                                ChatByIdView     │
│                                                takes over)      │
└─────────────────────────────────────────────────────────────────┘
```

**Note:** Steps 1 and 2 in this design map to the existing `connect` / `create_agent` server states. Step 3's "in progress" state is **not** server-tracked — it's purely client-driven by whether a chat exists for the freshly-created agent.

---

## 10. Out of scope: Step 4 — GitHub Automation

**Status: deferred.** Captured here for future continuation.

### 10.1 What Step 4 would have done

Install two GitHub Actions workflows that keep the Context Tree in sync with the source repo:
- `contextree.yaml` in source repo: on PR merge, generate a tree update PR via openai/codex-action
- `workflow_auto_review_and_merge.yaml` in tree repo: auto-review tree PRs via `codex review`, auto-merge if approved

Templates live in [first-tree-automation/lib/workflows/](https://github.com/agent-team-foundation/first-tree-automation/tree/main/lib/workflows). They are self-contained GitHub Actions; they only need `OPENAI_API_KEY` in the user's repo secrets to run.

### 10.2 Why deferred

- **Product positioning is unsettled.** first-tree-automation is not in `atf-launch`'s product roster. repo-gardener (a related context-aware PR review bot) is paused per atf-launch's ROADMAP.md. Building onboarding UX on top of an unsettled product line is premature.
- **It's a long-tail value feature.** New users don't feel the value in the first 5 minutes. They need to write code, open a PR, merge it, and wait for the workflow to fire. Onboarding optimizes for time-to-first-value; Step 4 doesn't help that.
- **External-secret dependency.** The auto-review workflow needs `OPENAI_API_KEY` in the user's tree repo secrets — a manual GitHub task with no programmatic shortcut. Forcing this in the first-time flow adds a 30-60s detour with high abandonment risk.
- **Architectural ambiguity.** The current first-tree-automation deployed at `https://github-bot-kappa.vercel.app/` requires its own GitHub App + webhook listener. Whether Hub should (a) hand off to that site, (b) absorb its install UI, (c) reimplement via user OAuth, or (d) drive it via the user's local agent — was not resolved.

### 10.3 Path to picking it back up

When Step 4 is reactivated:
1. Settle the github-automation product positioning (atf-launch ROADMAP). Is it first-tree-automation? Is it repo-gardener? Is it both? Is it neither?
2. Pick the integration architecture:
   - Most likely: **agent-driven** (matching Step 3) — user asks the agent to "set up auto-sync", agent uses the existing `gh` CLI auth on the user's machine to write workflow files, commit, push, open PRs. No Hub server work, no OAuth scope upgrade.
   - The proposal in §γ of conversation history captures this: extend Step 3's chat with a follow-up "Want auto-sync too?" question.
3. Add stepper step 4. Either:
   - As an opt-in continuation of Step 3 chat (γ form)
   - As a separate stepper entry (back to 4 steps)

The least-disruptive form is γ — keep stepper at 3 steps, automation is part of Step 3's open-ended chat.

---

## 11. Open questions

| ID | Question | Pending decision |
|---|---|---|
| ~~O-1~~ | ~~OAuth scope upgrade timing~~ | **SETTLED:** login-time, scope = `repo`. See §6.3. |
| ~~O-2~~ | ~~left rail behavior during onboarding~~ | **SETTLED:** normal. See §4.5. |
| ~~O-3~~ | ~~Step 1 form behavior + default team name~~ | **SETTLED:** show pre-filled, focus input, Enter advances. Default team name changes from `{display}` to `{login}'s team`. See §5.5. |
| ~~O-4~~ | ~~multi-client behavior in Step 2~~ | **SETTLED:** new users start with 0 clients by definition; multi-client is an edge case. Auto-pick most recent by `lastSeenAt` (current OnboardingView already does this — keep). No picker UI in onboarding. Multi-client picker UX belongs to post-onboarding NewAgentDialog only. |
| ~~O-5~~ | ~~`[I'll do it later]` semantics~~ | **SETTLED:** close the intro card; stepper stays on step 3. Body shows placeholder line: `Click \`Tree\` in the stepper above when you're ready.` Stepper dismiss is a separate action (✕ button). User can re-open the intro by clicking the Tree step in the stepper. |
| ~~O-6~~ | ~~Bootstrap message text~~ | **SETTLED:** reuse the existing first-tree onboarding one-liner: `Use the latest First-Tree CLI to install the skill in the current repository and complete the onboarding process: https://github.com/agent-team-foundation/first-tree`. Verbose for a reason — agent doesn't have the first-tree skill loaded yet (installing it IS the goal of Step 3), so the message must self-bootstrap the agent's knowledge of what tool and entry point to use. Same text used across PR #237 and any future first-tree install trigger — single source of truth. |
| ~~O-7~~ | ~~stepper visibility decoupling from onboardingStep~~ | **SETTLED:** plan (c) — stepper visibility tied to `users.onboarding_dismissed_at` (NULL → render, else hide). `onboardingStep` continues to drive OnboardingView body branching only. See §8 for the full mechanics. |

---

## 12. Sequencing / phases

Implementation order, smallest-shippable-first:

**Phase 1 — Stepper + Step 1/2 form rewrite**
- Add `users.onboarding_dismissed_at` column + migration
- Add layout-level `OnboardingStepper` component
- Refactor existing `OnboardingView` body to branch on `onboardingStep` (Step1Body, Step2Body)
- Step 1 = team name confirm
- Step 2 = current flow + add GitHub repo picker (req §6.3)
- OAuth scope upgrade flow (Q-2.A)
- Independently shippable: users at this phase complete onboarding at Step 2 (server says "completed"); stepper shows 2 step labels.

**Phase 2 — Step 3 IntroBody + ChatView routing**
- `Step3IntroBody` component rendered in OnboardingView
- CenterPanel routing change: `selectedChatId set` priority above `onboardingStep !== completed`
- Click [Yes, set it up] handler: create chat + send bootstrap message + navigate
- Stepper extends to 3 steps (Tree label added)
- Implements §11 O-7 resolution (c): stepper visibility decoupled from onboardingStep, tied to `dismissed_at`

**Phase 3 — Polish**
- Stepper dismiss button (✕)
- left rail behavior decision (O-2)
- Edge cases: Step 3 without OPENAI_API_KEY in tree repo (handled by skill, but worth noting), client offline during Step 2 (existing TimeoutBody pattern), repo picker edge cases (no repos, large repo lists).

**Phase 4 — Step 4 (deferred)**
- See §10 path. Needs prior product decision on github-automation positioning.

---

## 13. Plan B Amendments — locked decisions reversed during implementation

The original §4-§12 above froze a set of locked decisions before the implementation
started. During PR #248 several of those decisions were re-evaluated and reversed.
This section records each reversal, why it happened, and the actual shipped
behaviour. The earlier sections are preserved so readers can see the original
reasoning and the trade-off that was re-examined.

When §13 contradicts §6 / §7 / §8 / §11, **§13 wins** — it describes what shipped.

### 13.1 Repo picker moved from Step 2 to Step 3

**Original lock (§6.3, decision Q-2.A):** GitHub repo picker lives inside Step 2
alongside agent name + computer connect, so the user makes one cohesive
"create the agent" decision. O-1's OAuth `repo` scope upgrade was justified
specifically by Step 2's picker needing immediate availability.

**Reversal:** repo picker now lives inside Step 3 (`Step3IntroBody → RepoPickerSection`).

**Why:**
- Step 2's "create agent" must succeed even when GitHub OAuth is sluggish or the
  user's encrypted token is stale (e.g. after the `repo` scope upgrade — see
  `code: scope_missing` handling in [packages/server/src/api/me.ts](../packages/server/src/api/me.ts)).
  Coupling agent creation to a `/user/repos` call makes a transient GitHub blip
  block onboarding entirely.
- Step 3 is where the user is making the "context tree" decision; binding the
  source repo at the same moment is mentally adjacent (the tree is the source
  repo's knowledge layer).
- The agent created in Step 2 stays usable for non-code chat without a
  `gitRepos` binding; binding can fail without orphaning the agent.

**Behavioural consequence:** Step 2 creates an unbound agent (`gitRepos = []`).
Step 3 calls `updateAgentConfig({ gitRepos: [{ url }] })` after the user picks a
repo, immediately before creating the chat. `prepareGitWorktrees` in
[packages/client/src/handlers/claude-code.ts](../packages/client/src/handlers/claude-code.ts)
materialises the clone into the agent's session cwd subdirectory before the
bootstrap message runs.

**O-1 still applies:** the `repo` OAuth scope is still required at sign-in, just
for Step 3's picker rather than Step 2's.

### 13.2 Bootstrap message rewritten as natural-language prose, not a single verbatim line

**Original lock (§7.3, decision O-6):** the bootstrap message is a single verbatim
line shared with PR #237 and any other first-tree install trigger:
> `Use the latest First-Tree CLI to install the skill in the current repository and complete the onboarding process: https://github.com/agent-team-foundation/first-tree`

**Reversal:** bootstrap is now two prose helpers (`buildBindBootstrap` /
`buildCreateBootstrap`) selected by the user's "have a tree?" choice. Both
describe what to accomplish in natural language and reference the
`first-tree` / `first-tree` CLIs by name; neither inlines literal shell
commands.

**Why:**
- Established cross-session preference: Hub→agent first-message prose stays in
  natural language ("use the X CLI to do Y + URL"), with no inlined shell
  commands. Affirmed in conversation 2026-05-08; predates and supersedes O-6.
- The agent already has the first-tree skill loaded and the source repo
  materialised in its workspace via `gitRepos` — the message just states the
  goal; the skill knows the concrete commands.
- Path A vs Path B (existing tree vs new tree) want different downstream
  bookkeeping — Path A skips the `org bind-tree` callback because the URL is
  already known, Path B includes it because the agent will discover the URL
  after `gh repo create`. A single verbatim line cannot express both.

**Single-source-of-truth promise (O-6):** still aspirationally true within the
PR — only `Step3IntroBody` invokes these builders. If a future surface (e.g.
PR #237's auto-send path) needs the same prompts, hoist the helpers to
`packages/shared` so both import the same strings. This is a code-organisation
follow-up, not a decision to revisit.

### 13.3 Step 3 IntroBody became a 3-substep form, not a single intro card

**Original lock (§7.2 / §7.3):** Step 3 is a single intro card with `[Yes, set
it up]` / `[I'll do it later]` buttons; all tree-related decisions ("have a
tree? which one?") happen inside the chat with the agent (Q-3.B specifies
quick-reply chips in chat).

**Reversal:** Step 3 IntroBody is a vertical 3-substep frame:
1. Pick source repo
2. Toggle "Bind to existing tree" / "Create a new tree" (+ URL field if Bind)
3. `Continue` button → creates chat + sends bootstrap

**Why:**
- The agent's `ask-user` flow has a known compatibility issue with Claude Code
  and Codex runtimes (P0 owned by `yuezengwu`). Until that lands, in-chat
  quick-reply chips would be unreliable.
- Decisions made in the form before chat starts let the bootstrap message be
  fully self-contained — no back-and-forth with the agent before useful work
  begins.
- The form gives the user a clear sense of what's about to happen
  (which repo, which tree mode) before committing.

**Migration back to in-chat decisions (Q-3.B):** revisit once `ask-user`
compatibility is fixed. The form-based approach is intentional for the
current runtime constraints, not a permanent rejection of in-chat flow.

### 13.4 Stepper auto-dismisses after Step 3 chat starts

**Original lock (§7.4 / §8):** the stepper persists in Step 3 chat mode as
"the only signal you're still in onboarding". §8.1's entire decoupling rationale
exists to keep the stepper rendering during Step 3 chat.

**Reversal:** `Step3IntroBody.handleContinue` calls `dismissOnboarding()`
immediately after creating the chat, before navigating to `?c=<chatId>`. The
stepper unmounts as the user enters their first chat.

**Why:**
- The new chat is the workspace's primary surface from this moment on —
  onboarding chrome above it is visual noise, not guidance.
- §8's decoupling is still valuable for the dismiss control flow (single
  server-side flag, cross-tab consistency, recovery via `/settings/setup`),
  it just no longer exists *to keep stepper visible during chat*.
- The user has full agency to bring the stepper back via
  `Settings → Setup → Resume setup`.

**Side note:** the dismiss path also writes to `users.onboarding_dismissed_at`
exactly as `[I'll do it later]` and the stepper's `✕` do — three triggers,
single state field. The success path skips the "Setup hidden" toast (mid-success
is the wrong moment to nudge about hiding); the other two trigger it.

### 13.5 Scope additions beyond the original §4-§10 surface

The original §4.6 explicitly deferred a `/settings/setup` "Resume setup" page
to v1+. §6 / §7 didn't anticipate any CLI surface or per-org settings
namespace. Three additions shipped:

- **`/settings/setup` page + Resume setup button** — built in v1 because the
  stepper `✕` becomes a hostile one-way action without a recovery path. Same
  flag-flip mechanics as the design assumed; just a UI affordance for the
  user-visible inverse.
- **`first-tree org bind-tree <url>` CLI subcommand** — the agent invoked
  in Step 3's "Create new tree" path needs to record the freshly-created tree
  URL on the Hub so future agents in the team can find it. Doing this via the
  user's existing CLI credentials (rather than a new HTTP route the agent
  would need to learn) follows the same pattern as `first-tree client
  connect`. Test coverage for the CLI command itself is currently nil — flagged
  as a follow-up, not a merge blocker.
- **`organization_settings(context_tree)` namespace usage** — the Hub-side cache
  of the team's tree URL. Originally proposed as `organizations.tree_url`
  (column added then removed); rebased onto main's per-org settings
  infrastructure (#257) which provides a generic namespaced surface. The
  CLI subcommand and Step 3 Path A both read/write through this namespace.

### 13.6 Other minor deviations worth recording

- **Stepper `✕` dismiss gate** (§4.6): design described `✕` as
  always-clickable. Implementation gates it on `onboardingStep === "completed"`
  to prevent dismissing onto an empty workspace. Same gate also applies to the
  `/settings/setup` "Hide setup guide" affordance for symmetry.
- **Runtime `Powered by` chip** (§6.5): design removed the runtime indicator
  from Step 2. Implementation restored it as a small chip after the Plan B
  picker move — knowing which runtime the agent will use is a low-cost signal
  even when the runtime isn't user-selectable.

### 13.7 What is **not** reversed

For clarity, these remain as locked in §4-§12:

- 3-step structure (team / agent / context-tree) — unchanged
- Server-inferred `onboardingStep` enum (`connect` / `create_agent` /
  `completed`) — unchanged; rename from `wizardStep` per §8.5 is in
- `users.onboarding_dismissed_at` column + visibility decoupling — unchanged
- OAuth `repo` scope upgrade at signup — unchanged (still required, just for
  Step 3's picker now)
- Default team name `{login}'s team` — unchanged
- Step 4 (GitHub Automation) deferred — unchanged
- Invite-flow specifics — still a follow-up; conservative pre-fill from
  `context_tree.repo` ships in this PR but only helps admins (GET is
  admin-gated server-side); the proper invitee redesign is part of Phase B
  alongside the `source_repos` namespace

---

## 14. References

- Existing local-scenario doc: [docs/onboarding-redesign.md](onboarding-redesign.md)
- Standalone onboarding flow (current): [packages/web/src/pages/onboarding/](../packages/web/src/pages/onboarding/) — `onboarding-page.tsx`, `onboarding-flow.tsx`, `onboarding-shell.tsx`, `steps.ts`
- CenterPanel routing: [packages/web/src/pages/workspace/center/index.tsx](../packages/web/src/pages/workspace/center/index.tsx)
- ChatView: [packages/web/src/pages/workspace/center/chat-view.tsx](../packages/web/src/pages/workspace/center/chat-view.tsx)
- GitHub OAuth: [packages/server/src/api/auth/github.ts](../packages/server/src/api/auth/github.ts)
- Onboarding step inference: [packages/server/src/api/me.ts:304-322](../packages/server/src/api/me.ts:304)
- Agent runtime config (gitRepos): [packages/shared/src/schemas/agent-runtime-config.ts](../packages/shared/src/schemas/agent-runtime-config.ts)
- Git worktree materialization: [packages/client/src/handlers/claude-code.ts:682-700](../packages/client/src/handlers/claude-code.ts:682)
- first-tree skill onboarding doc: [skills/first-tree/references/onboarding.md](https://github.com/agent-team-foundation/first-tree/blob/main/skills/first-tree/references/onboarding.md)
- Related PR (NewAgentDialog rewrite, separate scope): [#237](https://github.com/agent-team-foundation/first-tree/pull/237)
