/**
 * Every user-facing string in the onboarding flow, in one place.
 *
 * Goal: a near-beginner can read these and know what to do and why. The
 * vocabulary is deliberately small: "team", "a computer", "agent", "Context
 * Tree".
 *
 * Core framing: an invited member first sees the standard personal First Tree
 * agent journey. Only after they explicitly continue without one do Team-agent
 * quick start and external Context access appear. BYO gives the coding agent
 * one self-contained prompt that connects the computer and enables Team
 * Context without creating a First Tree agent or completing onboarding. In
 * the recommended path, the detected executable is named directly instead of
 * introducing a category term users must learn before creating an agent.
 * "repo" stays (GitHub access / start-chat can still involve repos, and
 * "project" is ambiguous next to GitHub's own "Projects"). "binding" and
 * other deep internals still never leak.
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
  "create-team": {
    title: "Create a First Tree team",
    why: "A First Tree team is where you, your teammates, and your agents work together.",
  },
  "connect-computer": {
    // Keep the page title aligned to the canonical setup milestone. The body
    // can still explain that the action installs the First Tree background app,
    // but the page name should stay focused on the concrete computer being connected.
    title: "Connect this computer",
    // why is rendered per-state by StepConnectComputer (waiting shows the app
    // explainer; connected shows the detected agents + a bridge to create-agent).
    why: "",
  },
  "create-agent": {
    // Name the product-owned teammate explicitly so it cannot be confused
    // with the Claude Code / Codex process selected inside the form.
    title: "Create your First Tree agent",
    why: "",
  },
  "start-chat": {
    // title/why are rendered per-state by StepStartChat (new / existing / no
    // project / invitee sub-states); the shell skips them while empty.
    title: "",
    why: "",
  },
  "get-started": {
    // title/why are rendered per-sub-state by StepGetStarted (choose vs pick a
    // team agent); the shell skips them while empty.
    title: "",
    why: "",
  },
};

/** Shared phrases reused across steps so wording stays consistent. */
export const COPY = {
  /** Title shown across the flow's top chrome. */
  productName: "First Tree",
  continue: "Continue",
  back: "Back",
  cancel: "Cancel",
  skipForNow: "Skip for now",
  finishLater: "I'll finish later",
  hideSetup: "Hide setup",
  /** team (opening / welcome) states */
  team: {
    // A warm question that doubles as the field's label, sitting on its own line
    // above the input — so the pre-filled value is unmistakably the team's name
    // (a bare box with only a "rename" hint left the field's purpose ambiguous).
    // The question framing also implies the pre-filled name is editable.
    nameLead: "What should we call your team?",
  },
  /** connect-code states */
  connectCode: {
    // The old intro copy was deleted (R1 from baixiaohang review): it duplicated
    // `STEP_COPY['connect-code'].why` verbatim and had no remaining
    // consumer after the connect-code step started reading from
    // STEP_COPY directly. Keep the why as the single source of truth.
    // (The in-step two-phase indicator was removed — install + pick-repos is one
    // continuous action; a 2-segment bar inside a step that's already "Step N of
    // 3" read as confusing progress-within-progress. `phases` is gone.)
    cta: "Install First Tree on GitHub",
    waiting: "Waiting for GitHub…",
    // Context-tab build entry sends GitHub install + connect to Settings → GitHub
    // (the single place that binds an installation to the team) rather than doing
    // it inline, so the whole flow lives in one place. See context-tree-build-entry.tsx.
    connectInSettings: "Connect GitHub in Settings",
    connectInSettingsHint: "Install and connect there, then come back to build.",
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
    // Concise field-label for the repo picker — the subtitle already explains
    // ("choose which repos it can use"), so this just tags the field rather than
    // re-asking the question (and avoids echoing the subtitle's "choose…use").
    pickProject: "Repos your agent can use",
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
  },
  /** connect-computer states */
  connectComputer: {
    // Step subtitle, rendered per-state by the step (not the shell): the
    // command-pointing line only holds while waiting; once connected we swap
    // to a neutral confirmation so it doesn't tell the user to "run the
    // command below" when no command is shown.
    // The Client connects the computer and lets a managed First Tree agent run
    // there. It does not itself enable Team Context inside a personal provider
    // session, so keep that separate in the user-facing mental model.
    whyWaiting: "Install the First Tree app to connect this computer and detect what your agents can run.",
    // Once connected, the status row and detected options carry the result.
    // Repeating the install explanation would describe work the user has
    // already completed, so the connected state has no separate lead sentence.
    whyConnected: "",
    // One canonical install path: run the server-authored command in a terminal.
    terminalBoxLabel: "Run this command in your terminal",
    // Quiet caption naming the nested executable list without asking the user
    // to learn another category term such as "AI tool" or "coding agent".
    detectedLabel: "Available on this computer",
    // Bridge below the detected-agents list → the next step (create-agent).
    detectedBridge: "Next, create your First Tree agent.",
    waiting: "Waiting for your computer…",
    connected: "connected",
    // One line: the "✓ <host> connected" row above already says the computer is
    // connected (so no "Your computer is connected, but…" lead-in), and this is a
    // live polling state (so the dropped "it'll appear here automatically" tail is
    // implied — a detected agent just shows up). Problem + fix only.
    noRuntime: "Nothing your agents can run was found yet. Install Codex, Claude Code, or another supported option.",
    detecting: "Detecting what your agents can run…",
    /** Token-mint failure (POST /me/connect-tokens threw, after silent retries).
        Calm + recoverable: the auto-retry handles transient blips, so by the
        time this shows it's worth a manual Try again. */
    tokenErrorTitle: "We couldn't prepare your setup command — this is usually temporary.",
    retry: "Try again",
  },
  /** create-agent states */
  createAgent: {
    // Establish the durable product model first: this is the user's first of
    // potentially several agents in the current Team. The selected executable
    // is explained immediately below, where the choice is made.
    subtitle: "Build your own group of agents for different work in this team. Let’s create your first one.",
    // The detected executables define how this First Tree agent runs, without
    // collapsing the managed teammate identity into a renamed local tool.
    codingAgentLabel: "This agent will run",
    // Amber "not ready" badge beside the label when the computer dropped — so the
    // disabled picker reads AS unavailable (action needed: reconnect) at a glance,
    // not just a quietly greyed pill.
    codingAgentNotReady: "Not ready",
    nameLabel: "Name your agent",
    // "Bringing your agent online…" (not "Setting up…"): the step registers the
    // agent then polls until it comes online. Pairs with timeout's "isn't online
    // yet".
    creating: "Bringing your agent online…",
    creatingHint: "This usually takes a few seconds.",
    // Slow-start, NOT a failure: reached only after the full 60s server-liveness
    // window, so the agent is genuinely late — but a cold runtime or a waking
    // computer can still arrive, so the framing stays hopeful (keep waiting) with
    // a graceful, resumable exit (finish later) instead of an error. No second
    // title — the shell renders the step h1.
    timeoutBody:
      "Your agent is taking longer than usual to come online — its computer may be waking up. Keep waiting, or finish setup and start once it's ready.",
    keepWaiting: "Keep waiting",
    /** Shown on the form when the computer isn't connected (Create is disabled).
        One line with an inline "reconnect it" link (→ connect-computer). The old
        "to add your agent to the team" tail was dropped: the disabled "Create
        agent" button right below already shows the consequence, and the new
        "Not ready" badge + greyed picker carry the at-a-glance status — so this
        line just states the specific reason + the recover action. Auto-clears on
        reconnect. */
    computerDisconnected: {
      pre: "Your computer isn't connected — ",
      link: "reconnect it",
      post: ".",
    },
    /** Template intent handoff degraded (retired Template, failed detail
        fetch, or a stale handoff). Recoverable: plain create stays fully
        available, so the line states the loss and the path forward. */
    templateIntentUnavailable:
      "The template you started from is no longer available — you can still create your agent from scratch.",
  },
  /** One exact-agent arrival for every personal-agent start-chat path. */
  startChat: {
    eyebrow: "YOUR FIRST TREE AGENT",
    title: (agentDisplayName: string): string => `Meet ${agentDisplayName}`,
    body: (agentDisplayName: string): string =>
      `${agentDisplayName} is ready to explore First Tree with you. Bring a question, a project, or a task you want to move forward.`,
    meetAgent: "Meet your agent",
    nextStepHint: "You’ll open your first Chat and can start typing right away.",
    resolvingAgent: "Finding your agent…",
    resolveAgentFailed: "We couldn't load your agent just now.",
    resolveAgentRetry: "Try again",
    preparing: "Preparing your first Chat…",
    // shared launch transition
    starting: "Opening your first Chat…",
  },
  /** Progressive Member entry: one recommended personal-agent path first,
   *  then Team-agent and external Context access after explicit continuation. */
  getStarted: {
    joinedTeam: (team: string) => `You've joined ${team}`,
    recommendedTitle: "Set up your First Tree agent",
    recommendedWhy: "Create your own agent for ongoing work with your team.",
    computerReady: "Your computer is connected. Next, create your agent.",
    personalSteps: ["Connect computer", "Create agent", "Meet your agent"],
    continueWithout: "Continue without my own agent",
    personal: {
      cta: "Set up my agent",
      readyCta: "Create my agent",
    },
    byo: {
      description: "Add this team's Context Tree to one local project in Claude Code or Codex.",
      cta: "Use the Context Tree in Claude Code or Codex",
      checkingCta: "Checking Context Tree access…",
      error: "Couldn't check this option just now.",
      retry: "Try Context Tree access again",
    },
    pickTitle: "Pick a team agent",
    pickWhy: "Team agents are already set up by your team. Choose one to start chatting—nothing to install.",
    continueTitle: "Continue without your own agent",
    continueWhy: "Use what your team has already set up, without creating a personal First Tree agent.",
    /** Ownership tag on each row — descriptive wording, not a new product concept. */
    runBy: (owner: string) => `Run by ${owner}`,
    teamAgentExecution: (owner: string | null) =>
      owner
        ? `Uses ${owner}'s connected computer and coding plan`
        : "Uses its owner's connected computer and coding plan",
    startChat: "Start chat",
    pickEmpty: "No Team agent is available right now.",
    /** Roster read failed — distinct from empty, so a network blip never
     *  becomes a false "no agent available" claim. */
    pickError: "Couldn't load your team's agents just now.",
    pickRetry: "Try again",
    pickBack: "Back",
    byoSetupTitle: "Set up in your coding agent",
    byoSetupWhy:
      "Open Claude Code or Codex in the local project you want to work on, then paste one prompt. The project may be an ordinary folder with zero, one, or many source repositories.",
    byoBoundary:
      "This does not create a First Tree agent. Your coding-agent conversation stays outside First Tree Chat.",
    byoPreparingPrompt: "Preparing your setup prompt…",
    byoPromptTitle: "Setup prompt",
    byoPromptMeta: (provider: string, team: string) => `${provider} for ${team}`,
    byoPromptSummary:
      "Connects this computer if needed, enables Team Context for this local project, and verifies setup automatically.",
    byoCopyPrompt: "Copy setup prompt",
    byoViewPrompt: "View full prompt",
    byoPasteToContinue: (provider: string) =>
      `Paste into ${provider} opened at the project you want to use. Setup and verification happen there.`,
    byoCopyFailed: "Couldn't copy automatically. Open the full prompt and copy it manually.",
    byoUnavailable: "Needs Admin: your Team's Context Tree setup is not ready yet.",
    byoHandoffError: "Couldn't prepare the setup prompt just now. Try again.",
    byoRetryPrompt: "Try again",
    byoReturnToFirstTree: "Return to First Tree",
  },
  /** failure recovery, shared */
  errors: {
    generic: "Something went wrong. Try again in a moment.",
    chatFailed: "Couldn't open your first Chat. Try again.",
    agentFailed: "Couldn't add your agent to the team — please try again.",
    noAgent: "We couldn't find your agent. Go back a step and add one.",
  },
  /**
   * Human-readable messages for Context Tree provisioning failures at start-chat.
   * The server returns a machine `code` from POST /context-tree/initialize; we
   * map it to plain language + a way forward, rather than leaking the raw
   * server string (e.g. "administration: write and contents: write"). Keyed by
   * that code; an unmapped code falls back to the generic chat-failed message.
   */
  provisionErrors: {
    context_tree_repo_access_required:
      "First Tree's GitHub App can't access your team's Context Tree repo yet. Grant the App access to the repo on GitHub, then try again.",
    context_tree_repo_account_mismatch:
      "Your Context Tree repo must be created by the GitHub account that installed First Tree. Sign in as that account, or install First Tree on a GitHub organization.",
    github_user_token_required:
      "First Tree needs access to your GitHub account to create your team's Context Tree repo. Reconnect GitHub, then try again.",
    installation_permissions_insufficient:
      "First Tree's GitHub App is missing permissions it needs to create your team's tree. Update its access on GitHub, then try again.",
    no_installation: "GitHub isn't connected for your team yet. Connect it first, then try again.",
    suspended: "Your team's GitHub App installation is suspended. Re-enable it on GitHub, then try again.",
    not_configured: "GitHub isn't set up on this First Tree server yet. Ask your First Tree admin to finish the setup.",
    repo_unavailable:
      "First Tree couldn't create or access your team's Context Tree repo with the current GitHub App installation. Update the GitHub App repository access, then try again.",
    upstream: "Couldn't reach GitHub just now. Try again in a moment.",
  },
} as const;
