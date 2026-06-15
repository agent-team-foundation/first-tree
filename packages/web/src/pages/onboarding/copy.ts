/**
 * Every user-facing string in the onboarding flow, in one place.
 *
 * Goal: a near-beginner can read these and know what to do and why. The
 * vocabulary is deliberately small: "team", "a computer", "agent", "Context
 * Tree".
 *
 * Core framing: the user's coding agent (Claude Code, Codex, …) ALREADY
 * exists on their computer — onboarding *connects* it to the team, it does
 * not conjure a new abstract entity. So the tool names are first-class
 * vocabulary: we say "coding agent" as the category word and name the
 * concrete tool ("Claude Code") directly once it's detected. The verb chain
 * is Connect (link the tool) → Add (give it a team identity). "runtime" is NO
 * LONGER used in UI copy — it was once a sanctioned exception in
 * connect-computer, but "coding agent" / the tool's own name reads truer to
 * how the user already thinks about it. "repo" stays (connect-code / kickoff
 * install a GitHub App, and "project" is ambiguous next to GitHub's own
 * "Projects"). "binding" and other deep internals still never leak.
 * We distinguish people from AI: human members are
 * "teammates", the AI workers are "agents" (matching the rest of the product;
 * "AI agent" on first mention, then just "agent"). "Context Tree" is the one
 * product concept we deliberately teach (with a plain-language gloss on first
 * use) — it's the core of the product, so we name it rather than hiding it
 * behind a generic "knowledge base". Other implementation words never leak
 * into the UI; they stay in code and in the agent-facing bootstrap prose.
 *
 * Centralised so copy review is a single file, and so it can be unit tested
 * (no marketing word slips a banned term past review).
 */

import type { StepId } from "./steps.js";

export type StepCopy = {
  /** Heading at the top of the content column. */
  title: string;
  /** One plain-language sentence: why this step exists. */
  why: string;
};

export const STEP_COPY: Record<StepId, StepCopy> = {
  team: {
    // The admin's first screen is their welcome moment (the invitee path has
    // one too) — landing straight on a bare "Name your team" form felt abrupt.
    // The title greets, the why sets expectations, and naming the team becomes
    // a warm first action below rather than a cold prompt.
    title: "Welcome to First Tree",
    // Lead with the team (the thing being named right below), not the agent —
    // otherwise the value line and the naming field talk past each other. The
    // agent is introduced in the journey preview / its own step.
    why: "Let's start with your team — where you, your teammates, and your AI agents work together.",
  },
  "connect-code": {
    // "repo" (not "project"): this step connects a GitHub repository — the App
    // install dialog and the picker below both show repos as owner/name, and
    // "project" is ambiguous in a GitHub context (GitHub has a separate "Projects"
    // feature). This audience installs a GitHub App + runs a CLI, so "repo" reads
    // clearer than the beginner-softened "project". Role-framed and agent-centric,
    // matching the connect-computer title; NOT "your agent's repo" (the repo
    // belongs to the user/team, the agent only works on it).
    title: "Connect the repos your agent works on",
    // Answer "why connect a repo?" in value terms (the issue-834 UR gap): connecting
    // isn't just access — it's how the agent learns the repo and turns it
    // into the team's shared context. The second clause reassures the user the
    // agent won't touch their code unsupervised.
    why: "Connect a repo so your agent can learn your codebase and work on it. It never changes your code without your okay.",
  },
  "connect-computer": {
    // The user's coding agent already exists on their computer (Claude Code,
    // Codex, …) — this step CONNECTS it, so the title names that act directly
    // rather than the old "set up where your agent runs", which implied an
    // abstract agent living somewhere the user couldn't see. "coding agent" is
    // the category word; the concrete tool gets named once detected. First verb
    // in the Connect → Add chain.
    title: "Connect your coding agent",
    // why is rendered per-state by StepConnectComputer (the "run the command
    // below" line is only true while waiting — once connected there's no
    // command shown, so a static shell subtitle would read as stale). The
    // shell skips it while empty.
    why: "",
  },
  "create-agent": {
    // The agent was connected in the previous step; here it joins the team — so
    // the title is "Add … to the team", not "Create …" (nothing is created; an
    // existing tool gets a team identity). This step is name + visibility (+
    // future settings), i.e. join-the-team registration. Second verb in the
    // Connect → Add chain. NOT "your AI teammate": the vocabulary reserves
    // "teammate" for humans and "agent" for AI. No `why` — title + form
    // self-explain.
    title: "Add your agent to the team",
    why: "",
  },
  kickoff: {
    // title/why are rendered per-state by StepKickoff (new / existing / no
    // project / invitee sub-states); the shell skips them while empty.
    title: "",
    why: "",
  },
  welcome: {
    title: "Welcome to the team",
    // The personalized one-liner (with the team name) lives in StepWelcome's
    // body, so the static why stays empty — avoids the old why+body
    // duplication, and the step list is dropped (the progress bar covers it).
    why: "",
  },
};

/** Shared phrases reused across steps so wording stays consistent. */
export const COPY = {
  /** Title shown across the flow's top chrome. */
  productName: "First Tree",
  continue: "Continue",
  /** Opening-step advance (team / invitee welcome) — warmer than "Continue". */
  getStarted: "Get started",
  back: "Back",
  cancel: "Cancel",
  skipForNow: "Skip for now",
  finishLater: "I'll finish later",
  hideSetup: "Hide setup",
  /** team (opening / welcome) states */
  team: {
    // Welcome-screen copy, kept terse — greeting + value live in STEP_COPY;
    // here are just the field label and a 3-word reassurance. No step preview:
    // the progress bar already names where you are once you start, so listing
    // the steps here only added reading + chore-list weight.
    nameLabel: "What should we call your team?",
    renameHint: "Rename it anytime.",
  },
  /** connect-code states */
  connectCode: {
    // `intro` was deleted (R1 from baixiaohang review): it duplicated
    // `STEP_COPY['connect-code'].why` verbatim and had no remaining
    // consumer after the connect-code step started reading from
    // STEP_COPY directly. Keep the why as the single source of truth.
    /** The step's two sub-phases, shown as an in-step indicator so the user can
        see it's "connect, then pick" and where they are. */
    phases: ["Connect GitHub", "Pick repos"],
    cta: "Install on GitHub",
    waiting: "Waiting for GitHub…",
    // (connected status row removed — the PhaseNav's "✓ Connect GitHub" already
    // signals the connection, and the repo picker shows the org + repos.)
    pickProject: "Which repos should your agent work on?",
    /** Loading state for the repo picker (was hardcoded in the step). */
    loading: "Loading your repos…",
    // The picker is sourced from the team's GitHub App installation grant, so
    // "your GitHub account" would be wrong — an empty list means the App was
    // connected but isn't granted any repos yet.
    noRepos: "No repos are shared with First Tree yet — add some on GitHub, or continue without one.",
    // Recovery variant: there is no "continue without one" here — a tree can't
    // be built without a repo, so point at the only way forward (grant repos).
    noReposRecovery: "No repos are shared with First Tree yet. Grant access to one on GitHub, then it'll show up here.",
    // Shown when the org-scoped repo list fails to load (502 upstream / 503
    // suspended etc.). The new installation-backed endpoint can return these,
    // and without this branch the failure was misrendered as an empty
    // "no projects" list. The "Continue without a repo" button below keeps
    // it from being a dead end.
    loadFailed: "Couldn't load your team's repos — continue without one for now.",
    // Recovery variant: no "continue without" — offer a retry instead.
    loadFailedRecovery: "Couldn't load your team's repos. Try again in a moment.",
    loadFailedRetry: "Try again",
    reconnect: "Reconnect GitHub with repo access",
    // Collapsed the two rare, not-user-fixable install errors (App not set up on
    // this server / caller lacks permission) into one recoverable message — the
    // action is the same either way (continue, set up later), so two separate
    // screens added surface without adding clarity.
    cantConnect: "Couldn't connect a repo here right now — continue now and add one later from Settings.",
    // Recovery variant: building a tree needs the GitHub App connected, and the
    // recovery surface has no skip — so name what's required (an org owner must
    // install it). The shell's "Back to workspace" is the way out.
    cantConnectRecovery:
      "Couldn't connect a repo here. Building your team's Context Tree needs First Tree connected to GitHub — a GitHub org owner has to install it. Once it's connected, come back.",
    continueWithout: "Continue without a repo",
    continueNoProject: "Continue without a repo",
    // Shown when the picker has repos but none are selected. Connecting one is
    // the whole point of this step — it's what gives the team a Context Tree —
    // so we add friction (state the consequence + a quieter skip button), but
    // never block: a beginner should still be able to move on.
    noRepoConsequence:
      "Pick a repo so your agent can build your team's Context Tree. Without one, teammates who join will be left waiting until you connect one.",
    /**
     * Shown under the CTA/Skip row: the install caveat (who can install) merged
     * with the skip reassurance into one muted line. `emphasis` renders bold so
     * the gating fact ("a GitHub org owner") stands out. The Request-instead-of-
     * Install mechanic lives in Need help? (step 3), keeping this one tight line.
     */
    notOwnerHint: {
      pre: "Only ",
      emphasis: "a GitHub org owner",
      post: " can install First Tree — if that's not you, clicking Install asks an owner to approve. You can skip and connect anytime from Settings.",
    },
    /** Explicit "abandon the in-flight attempt and re-mint" action, shown under
        the "Waiting for GitHub…" status. Retry is deliberate (not an
        auto-unlocked button) because a fresh install URL overwrites the
        `oauth_state_nonce` cookie — re-minting while the first install tab is
        mid-flow would fail its callback. */
    restartInstall: "Didn't work? Start over",
    /**
     * Troubleshooting shown inside the "Need help?" disclosure (alongside the
     * InstallGuide how-to), mirroring connect-computer. The disclosure
     * auto-opens when the user returns from GitHub without an installation, so
     * the title is state-neutral (it can also be opened proactively).
     */
    /** "Need help?" InstallGuide — a 3-beat visual flow + numbered how-to,
        written to match GitHub's REAL App-install screen: choose where to
        install → pick repo access (all / select) → click Install (or Request,
        for non-owners) → auto-return. */
    installFlow: ["Choose org", "Pick repos", "Install", "Back here"],
    installFlowAria: "Flow: choose your org, pick repos, click Install on GitHub, then return to setup.",
    installSteps: [
      "Choose where to install First Tree — your team's GitHub org (or your account, if your repos live there).",
      "Pick which repos it can access: all of them, or just the ones you choose.",
      "Click Install. Not a GitHub org owner? The button says Request instead — an owner approves it.",
      "GitHub sends you straight back here, and this page connects on its own.",
    ],
    troubleshootTitle: "If it didn't connect:",
    troubleshootBody:
      "Make sure you clicked Install (or Request) on GitHub. If you're not a GitHub org owner, an owner has to approve it — once they do, it connects here automatically.",
    // (skipReassure merged into `notOwnerHint` — one muted line under the row.)
  },
  /** connect-computer states */
  connectComputer: {
    // Step subtitle, rendered per-state by the step (not the shell): the
    // command-pointing line only holds while waiting; once connected we swap
    // to a neutral confirmation so it doesn't tell the user to "run the
    // command below" when no command is shown.
    // whyWaiting names the tools (Claude Code / Codex) and points the command
    // at the machine where they're installed — the user's coding agent already
    // lives there, so running the command connects it. The "— that connects it
    // to your team" tail gives the bare command its purpose.
    whyWaiting:
      "Run this command on the computer where you installed Claude Code, Codex, or other coding agents — that connects it to your team.",
    whyConnected: "Your computer's connected.",
    waiting: "Waiting for your computer…",
    connected: "connected",
    noRuntime:
      "Your computer is connected, but we didn't find a coding agent on it. Install one (like Claude Code) and sign in — it'll show up here automatically.",
    detecting: "Looking for coding agents on it…",
    /**
     * Ready · exactly one coding agent detected — nothing to choose, so name
     * the tool and bridge into the next step. `name` is the friendly
     * PROVIDER_LABEL (e.g. "Claude Code").
     */
    runtimeReady: (name: string) => `${name} is ready on this computer. Next, add it to your team.`,
    /**
     * Ready · two or more coding agents detected — state the count and prompt
     * the user to pick which one to connect first (a single-select list
     * follows).
     */
    runtimesReady: (count: number) =>
      `We found ${count} coding agents on this computer — pick which one to connect first.`,
    stuckTitle: "Taking a while? A few common reasons:",
    stuckReasons: [
      "If you saw “command not found”, your computer needs Node.js first — it's a free install. Get it, then run the command again.",
      "Make sure you ran it on the computer where your coding agent is installed.",
      "A company firewall or VPN can sometimes block the connection.",
    ],
    nodeLinkLabel: "Install Node.js (free)",
    nodeUrl: "https://nodejs.org",
    /** "Need help?" disclosure — label, and the stuck variant it switches to. */
    helpStuckLabel: "Taking a while? Need help?",
    /** Troubleshooting block inside the disclosure (neutral title — it can be
        opened proactively, not only when stuck). Reuses `stuckReasons`. */
    troubleshootTitle: "If it's not connecting:",
    /** Token-mint failure (POST /me/connect-tokens threw, after silent retries).
        Calm + recoverable: the auto-retry handles transient blips, so by the
        time this shows it's worth a manual Try again. */
    tokenErrorTitle: "We couldn't prepare your setup command — this is usually temporary.",
    retry: "Try again",
  },
  /** create-agent states */
  createAgent: {
    // Dynamic opener at the top of the step: names the connected tool + the
    // machine it's on, grounding the abstract "agent" in the concrete coding
    // agent the user already runs (e.g. "Claude Code on gandys-macbook is about
    // to join your team."). Rendered only when both are known.
    joining: (toolLabel: string, hostname: string) => `${toolLabel} on ${hostname} is about to join your team.`,
    nameLabel: "What should your team call it?",
    // "Bringing your agent online…" (not "Setting up…"): the step registers the
    // agent then polls until it comes online. Pairs with timeout's "isn't online
    // yet".
    creating: "Bringing your agent online…",
    creatingHint: "This usually takes a few seconds.",
    // Timeout: added but didn't report online within 30s. ONE paragraph, no
    // separate bold title — the shell already renders the step h1 ("Add your
    // agent to the team"), so a second heading read as a stacked double-title.
    // Leads with the situation, then causes + fix. "coding agent" matches
    // connect-computer.
    timeoutBody:
      "Your agent isn't online yet — the computer it runs on may have gone to sleep, lost its connection, or the coding agent didn't start. Check that computer, then try again.",
    retry: "Try again",
    /** Shown on the form when the computer isn't connected (Create is disabled).
        Rendered as one line with an inline "reconnect it" link (→ connect-computer)
        rather than a separate orphaned link line. Auto-clears on reconnect. */
    computerDisconnected: {
      pre: "Your computer isn't connected — ",
      link: "reconnect it",
      post: " to add your agent to the team.",
    },
  },
  /** kickoff — one unified "launch" finale across every path. Titles/bodies are
      rendered per-state by the step; the shell leaves STEP_COPY.kickoff empty
      for this bookend. */
  kickoff: {
    // admin · new tree (the default — the team has none yet). Lead with the
    // agent + the outcome (it seeds your team's memory from your code), not a
    // Context-Tree lecture; the term is named once, lightly.
    newTitle: "Your agent's ready to get to work",
    newWhy: (repoCount: number): string =>
      `It'll start by reading your ${repoCount === 1 ? "repo" : `${repoCount} repos`} and drafting your team's Context Tree — the shared memory that lets every agent work like it already knows your project.`,
    startBuilding: "Build tree & start",

    // admin · the team already has a Context Tree (re-run / second admin /
    // CLI-bound). Detected silently — no fork, no paste — the agent reads it
    // instead of seeding.
    existingTitle: "Your agent's ready to get to work",
    existingWhy: (repoCount: number): string =>
      `Your team already has a Context Tree — your agent will get oriented and start working on your ${repoCount === 1 ? "repo" : `${repoCount} repos`}.`,
    startExisting: "Start",

    // admin · no repo connected (connect-code skipped / 0 picked). Nothing to
    // seed from, so this is honestly "meet your agent" — not a tree moment. The
    // affordance points back to connecting a repo (the only way to give the team
    // a Context Tree), not a silent "do it later in Settings".
    noProjectTitle: "Your agent's ready",
    noProjectBody: "No repo connected, so your agent will start with a quick intro.",
    connectRepoAffordance: "Want a team Context Tree? Connect a repo",
    startChatting: "Meet your agent",

    // invitee · ready (team has a tree + a GitHub connection). Replaces the old
    // confirm/picker screens — the agent already inherits the team's repos
    // automatically (recommended team resources are enabled for every org
    // agent), so there is nothing to select.
    inviteeReadyTitle: "Your agent's ready to go",
    // Deliberately does NOT name specific repos or claim guaranteed access: an
    // agent clones a team repo with the host machine's git credentials (no org
    // token is injected), so a joining member without access to a private team
    // repo can't reach it. "works with your team's repos" stays true regardless.
    inviteeReadyWithRepos: "Your team's all set up — your agent works with your team's repos and shared Context Tree.",
    // No "add from Settings": connecting team repos is admin-only, and this is
    // shown to a joining member, so it must not imply they can do it themselves.
    inviteeReadyNoRepos:
      "Your team's all set up — your agent will start with a quick intro. An admin can connect team repos anytime.",
    startWorking: "Start working",

    // shared launch transition
    starting: "Starting your agent…",
  },
  /** invitee blocked states — the team isn't ready yet (no tree, or no GitHub) */
  invitee: {
    waitingTitle: "Waiting for your team to set up",
    waitingBody:
      "Your team's admin is still setting up repos and a Context Tree. This page updates on its own as soon as they're done.",
    waitingStatus: "Watching for updates…",
    // admin set up a tree but never connected the GitHub App; without an
    // installation every git op the agent runs would 403, so we hold here.
    noInstallTitle: "Almost there — your team's repo isn't connected yet",
    noInstallBody:
      "Your team's admin set up the Context Tree but hasn't connected a repo on GitHub yet. Your agent needs that connection to do real work.",
    noInstallStatus: "Watching for the connection…",
    // Bailout on the blocked screens — meet your agent now (an intro chat)
    // instead of waiting on the team.
    startAnyway: "Meet your agent",
  },
  /** failure recovery, shared */
  errors: {
    generic: "Something went wrong. Try again in a moment.",
    chatFailed: "Couldn't start the first task. Try again.",
    agentFailed: "Couldn't add your agent to the team — please try again.",
    noAgent: "We couldn't find your agent. Go back a step and add one.",
  },
  /**
   * Human-readable messages for Context Tree provisioning failures at kickoff.
   * The server returns a machine `code` from POST /context-tree/initialize; we
   * map it to plain language + a way forward, rather than leaking the raw
   * server string (e.g. "administration: write and contents: write"). Keyed by
   * that code; an unmapped code falls back to the generic chat-failed message.
   */
  provisionErrors: {
    organization_installation_required:
      "First Tree is connected to a personal GitHub account, but a team Context Tree needs a GitHub organization. Connect First Tree to an org, then try again.",
    selected_repositories_unsupported:
      "First Tree's GitHub App can only see selected repositories. Give it access to all repositories on GitHub, then try again.",
    installation_permissions_insufficient:
      "First Tree's GitHub App is missing permissions it needs to create your team's tree. Update its access on GitHub, then try again.",
    no_installation: "GitHub isn't connected for your team yet. Connect it first, then try again.",
    suspended: "Your team's GitHub App installation is suspended. Re-enable it on GitHub, then try again.",
    not_configured: "GitHub isn't set up on this First Tree server yet. Ask your First Tree admin to finish the setup.",
    repo_unavailable:
      "A GitHub repo for your team's Context Tree already exists but First Tree can't access it. Give the GitHub App access to it (or remove it), then try again.",
    upstream: "Couldn't reach GitHub just now. Try again in a moment.",
  },
  /**
   * Build-Tree recovery — the standalone /build-tree surface + its two entry
   * points, for an admin who finished onboarding without connecting code (so
   * their team has no Context Tree yet). Framed as building the missing tree,
   * never as a failed setup.
   */
  buildTree: {
    /** Constant title for the recovery surface — names the thing being created
     *  (the team's shared Context Tree). The per-step kickoff heading is
     *  suppressed (StepKickoff `recovery`) so this carries both steps. */
    title: "Build your team's Context Tree",
    /** connect-code hint when no repo is selected — recovery REQUIRES one (a
     *  tree can't be built without source repos), so unlike onboarding there's
     *  no "continue without a repo" out. */
    connectRepoHint: "Pick at least one repo — your agent builds the tree from it.",
    /**
     * The ONE action label, used identically on all three tree-creation
     * surfaces (Context page, Settings → Setup card, Settings → Context tree).
     * Always a link, never a green CTA button. Routes into the `/build-tree`
     * flow, which connects code then builds — so the label says both. Uses
     * "your code" (number-agnostic) because the flow connects one OR more repos.
     */
    buildCta: "Connect your code & build your Context Tree",
    /** Settings → Setup recovery card (entry A) — title + body above the link. */
    cardTitle: "Build your Context Tree",
    cardBody:
      "You finished setting up without connecting a repo, so your team has no Context Tree yet — your agent drafts the first pieces with you once you do.",
    /** Context page empty-state (entry B) — title + body above the link. */
    bannerTitle: "Your team has no Context Tree yet",
    bannerBody: "Connect your code and your agent will build your team's shared memory with you in the chat.",
  },
} as const;
