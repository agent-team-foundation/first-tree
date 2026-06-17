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
    // Reframed around "you + your local coding agent joining a First Tree team":
    // matches the product's "your coding agent already exists, connect it" framing
    // (Claude Code / Codex are first-class vocabulary).
    why: "You and your local coding agent (Claude Code, Codex) join a First Tree team to work together.",
  },
  "connect-code": {
    // "repo" (not "project"): this step connects a GitHub repository — the App
    // install dialog and the picker below both show repos as owner/name, and
    // "project" is ambiguous in a GitHub context (GitHub has a separate "Projects"
    // feature). This audience installs a GitHub App + runs a CLI, so "repo" reads
    // clearer than the beginner-softened "project". Role-framed and agent-centric,
    // matching the connect-computer title; NOT "your agent's repo" (the repo
    // belongs to the user/team, the agent only works on it).
    // Short, clear action in the title; the "why" + reassurance ride in the
    // subtitle (titles get read, subtitles get skimmed — but the action is
    // self-evident enough, and the why is one glance below). "code" (not jargon
    // "repo") for the concept; "repos" is reserved for the actual selection.
    title: "Connect to GitHub",
    // why = value + reassurance. The "install the GitHub App" mechanism lives on
    // the CTA button (so this never reads as "install software"); the reassurance
    // ("never changes them without your okay") is kept — it's worth a lot at the
    // first GitHub authorization.
    why: "Your agent works on your code. Connect your GitHub and choose which repos it can use — and it never changes them without your okay.",
  },
  "connect-computer": {
    // Reframed: this step installs the First Tree client (a small background app)
    // on the user's computer — "client" is too jargon for beginners and "on this
    // computer" is the norm (a wrong machine is caught by the next step's
    // "no coding agent detected" state), so the title is just "Install First Tree".
    title: "Install First Tree",
    // why is rendered per-state by StepConnectComputer (waiting shows the app
    // explainer; connected shows the detected agents + a bridge to create-agent).
    why: "",
  },
  "create-agent": {
    // Reframed to "Create your first agent" (more intuitive than the old "Add …
    // to the team"). The two-layer "agent vs coding agent" confusion is handled
    // by COLLAPSING the model in the subtitle ("your Claude Code/Codex becomes a
    // team agent"), not by explaining a runtime/entity distinction.
    title: "Create your first agent",
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
    // The ceremonial admin opening. This bookend renders no progress bar, so the
    // single-line roadmap below the hero (StepRoadmap, which derives the "N
    // steps" count from this list) is the only orientation. The admin journey
    // after team: install → create agent → connect GitHub.
    nextSteps: ["Install First Tree", "Create your first agent", "Connect to GitHub"],
    // A warm question that doubles as the field's label, sitting on its own line
    // above the input — so the pre-filled value is unmistakably the team's name
    // (a bare box with only a "rename" hint left the field's purpose ambiguous).
    // The question framing also implies the pre-filled name is editable.
    nameLead: "What should we call your team?",
  },
  /** connect-code states */
  connectCode: {
    // `intro` was deleted (R1 from baixiaohang review): it duplicated
    // `STEP_COPY['connect-code'].why` verbatim and had no remaining
    // consumer after the connect-code step started reading from
    // STEP_COPY directly. Keep the why as the single source of truth.
    // (The in-step two-phase indicator was removed — install + pick-repos is one
    // continuous action; a 2-segment bar inside a step that's already "Step N of
    // 3" read as confusing progress-within-progress. `phases` is gone.)
    cta: "Install First Tree on GitHub",
    waiting: "Waiting for GitHub…",
    /** Post-install confirmation. The account a GitHub App is installed on is
        set by whoever's github.com session was active at install time — which
        is NOT necessarily the account the user signed into First Tree with. So
        name the connected account/org explicitly here, letting the user catch
        "installed on the wrong account/org" before they pick repos (the picker
        alone only implies it via repo names). */
    connected: {
      label: "Connected to",
      /** Granted-repo count, shown once the repo list loads. */
      repoCount: (n: number) => `${n} ${n === 1 ? "repository" : "repositories"} available`,
    },
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
    whyWaiting: "A small background app that lets your local coding agents (Claude Code, Codex) connect to your team.",
    whyConnected:
      "A small background app that lets your local coding agents (Claude Code, Codex) connect to your team.",
    // Two install paths (waiting state): run in a terminal, or paste a ready
    // prompt to the coding agent the user already has and let it install.
    terminalBoxLabel: "Run this command in your terminal",
    agentBoxLabel: "Or paste this to your Claude Code or Codex agent",
    agentPromptPrefix: "Help me install First Tree by running the command below:",
    // Bridge below the detected-agents list → the next step (create-agent).
    detectedBridge: "Next, create your first agent.",
    // Stuck recovery (replaces the Need-help disclosure): ONE line, Node.js the
    // #1 cause of "command not found". `nodeLinkLabel` is the inline link.
    stuckNodePre: "“command not found”? → ",
    stuckNodePost: ", re-run.",
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
    // Collapsed-model subtitle: the agent the user creates IS their local coding
    // agent given a team identity — no "powered by / runtime" two-layer framing.
    subtitle: "Your Claude Code or Codex becomes a team agent. Choose which one, name it, and set who can use it.",
    // Coding-agent picker (moved here from connect-computer): always a list, even
    // for one, default-selected to Claude Code when present.
    codingAgentLabel: "Coding agent",
    nameLabel: "Name your agent",
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
      `It'll read your ${repoCount === 1 ? "repo" : `${repoCount} repos`} and draft your team's Context Tree — shared memory every agent works from.`,
    startBuilding: "Build tree & start",

    // admin · the team already has a Context Tree (re-run / second admin /
    // CLI-bound). Detected silently — no fork, no paste — the agent reads it
    // instead of seeding.
    existingTitle: "Your agent's ready to get to work",
    existingWhy: (repoCount: number): string =>
      `Your team already has a Context Tree — your agent gets oriented and starts on your ${repoCount === 1 ? "repo" : `${repoCount} repos`}.`,
    startExisting: "Start",

    // admin · no repo connected (connect-code skipped / 0 picked). "No repo" and
    // "no Context Tree" are the same state, so frame it as the tree being absent
    // (the value), not the mechanism. The title is honest, not a "you're done"
    // celebration — the agent works, but the team has no Context Tree yet. The
    // recovery is inline in the body: "Connect GitHub" routes back to connect-code
    // (install + pick a repo), the same pre/link/post idiom as create-agent's
    // "reconnect it". The agent stays usable now (Meet your agent), so this nudges
    // toward the tree without blocking the lighter start.
    noProjectTitle: "Your agent's ready — but your team has no Context Tree yet",
    noProjectBody: {
      pre: "No repo connected, so your agent will start with a quick intro. ",
      link: "Connect GitHub",
      post: " to build your team's Context Tree.",
    },
    startChatting: "Meet your agent",

    // invitee · ready (team has a tree + a GitHub connection). Replaces the old
    // confirm/picker screens — the agent already inherits the team's repos
    // automatically (recommended team resources are enabled for every org
    // agent), so there is nothing to select.
    inviteeReadyTitle: "Your agent's ready to go",
    // Names what the agent actually has — the team's repos + shared Context Tree —
    // because onboarding is where we teach that concept, and a joining teammate
    // benefits from knowing their agent isn't a blank assistant. One line for every
    // ready case (the agent inherits the team's recommended repos automatically,
    // so there's nothing to pick). Deliberately doesn't claim specific repo ACCESS:
    // an agent clones with the host's git credentials, so "works with your team's
    // repos" stays true regardless — a member without access to a private repo just
    // can't reach that one.
    inviteeReadyBody: "Your team's all set up — your agent works with your team's repos and shared Context Tree.",
    startWorking: "Start working",

    // shared launch transition
    starting: "Starting your agent…",
  },
  /** invitee · ceremonial welcome + the one not-ready (blocked-on-admin) state.
   *  The not-ready screen covers both "no Context Tree" and "no GitHub
   *  connection" — the invitee can't act on either, and it advances on its own
   *  once the admin finishes. */
  invitee: {
    // The invitee's ceremonial welcome (mirrors the admin opening). `welcomeBody`
    // brackets the team name (rendered bold in StepWelcome); the one-line
    // roadmap (StepRoadmap) derives its "N steps" count from `nextSteps`. The
    // invitee journey has no connect-code (they inherit the team's repos):
    // install → create agent → start working.
    welcomeBody: {
      pre: "You're now part of ",
      // A single warm value line that names the coding agent (Claude Code,
      // Codex) — symmetric with the admin opening's subtitle, and true to the
      // "connect your existing coding agent" framing. Deliberately does NOT
      // restate the roadmap's "Create your first agent" or echo the Get started
      // CTA — the roadmap + button carry the action; this carries the welcome.
      post: " — let's bring your coding agent (Claude Code, Codex) onto the team.",
    },
    nextSteps: ["Install First Tree", "Create your first agent", "Start working"],
    // Title states the fact; the body leads with the action, not the wait. In the
    // default-none world the most common not-ready cause is "admin finished
    // without a tree", which never resolves — so "Meet your agent" is the real
    // path forward (the primary CTA), and the auto-advance is a quiet conditional
    // footnote (notReadyStatus), never a "coming soon" promise the team may break.
    notReadyTitle: "Your team is still setting up",
    notReadyBody: "No need to wait — meet your agent now.",
    notReadyStatus: "This page continues on its own if your team finishes setup.",
    // The primary action on the not-ready screen — start an intro chat now
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
