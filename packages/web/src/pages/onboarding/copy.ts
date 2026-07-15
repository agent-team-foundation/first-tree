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
 * how the user already thinks about it. "repo" stays (GitHub access / start-chat
 * can still involve repos, and "project" is ambiguous next to GitHub's own
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
    // The title keeps the user's first team agent as the object they are
    // creating; the subtitle carries the local coding-agent relationship.
    title: "Create your first agent",
    why: "",
  },
  "start-chat": {
    // title/why are rendered per-state by StepStartChat (new / existing / no
    // project / invitee sub-states); the shell skips them while empty.
    title: "",
    why: "",
  },
  "join-team": {
    title: "Join the team",
    why: "A First Tree team is where you, your teammates, and your agents work together.",
  },
  "get-started": {
    // title/why are rendered per-sub-state by StepGetStarted (choose vs pick a
    // team agent); the shell skips them while empty.
    title: "",
    why: "",
  },
};

/** One plain launch line for every start-chat finale — admin or invitee, team
 *  ready or not. The team/tree state behind these variants is invisible to the
 *  user (the Context Tree is introduced later, in chat), so a per-state subtitle
 *  would only surface backend readiness they can't act on — and would name
 *  "context" before the user has met the concept. So every finale shows this one
 *  line. Title stays "Start working with your agent"; this is the subtitle. */
const START_CHAT_LAUNCH_WHY = "Your agent's ready. Start a chat and it'll help you get going.";

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
    // whyWaiting names the tools (Claude Code / Codex) and points the command
    // at the machine where they're installed — the user's coding agent already
    // lives there, so running the command connects it. The "— that connects it
    // to your team" tail gives the bare command its purpose.
    whyWaiting: "A background app that connects your local coding agents (Claude Code, Codex) to your First Tree team.",
    whyConnected:
      "A background app that connects your local coding agents (Claude Code, Codex) to your First Tree team.",
    // Two install paths (waiting state): run the bare command in a terminal, or
    // paste a ready prompt to the coding agent the user already has — the prompt
    // wraps the command in a "please run this" line so the agent executes it
    // instead of just explaining a bare command.
    terminalBoxLabel: "Run this command in your terminal",
    agentBoxLabel: "Or paste this to your Claude Code, Codex, or Cursor agent",
    agentPromptPrefix: "Help me install First Tree by running the command below:",
    // Quiet caption naming the nested coding-agent list, so the indented rows
    // read as "found ON this computer" (the relationship the nesting implies)
    // rather than as an unlabelled cluster. Count-aware so a single detection
    // doesn't read as a plural label.
    detectedLabel: (count: number) =>
      count === 1 ? "Coding agent on this computer" : "Coding agents on this computer",
    // Bridge below the detected-agents list → the next step (create-agent).
    detectedBridge: "Next, create your first agent.",
    waiting: "Waiting for your computer…",
    connected: "connected",
    // One line: the "✓ <host> connected" row above already says the computer is
    // connected (so no "Your computer is connected, but…" lead-in), and this is a
    // live polling state (so the dropped "it'll appear here automatically" tail is
    // implied — a detected agent just shows up). Problem + fix only.
    noRuntime: "No coding agent found yet. Install one (like Claude Code) and sign in.",
    detecting: "Looking for coding agents on it…",
    /** Token-mint failure (POST /me/connect-tokens threw, after silent retries).
        Calm + recoverable: the auto-retry handles transient blips, so by the
        time this shows it's worth a manual Try again. */
    tokenErrorTitle: "We couldn't prepare your setup command — this is usually temporary.",
    retry: "Try again",
  },
  /** create-agent states */
  createAgent: {
    // Subtitle = relationship + a smooth, generic lead-in to the setup. The
    // SUBJECT carries the relationship ("your local coding agent" — the category
    // word, NOT the tool names, which live in the field's pills +
    // `codingAgentHint`); "ready to join your First Tree team" says what's
    // happening, and "let's set it up" invites the configuration below WITHOUT
    // enumerating / echoing the field labels (the robotic "Choose which one,
    // name it, and set who can use it" list was the redundancy we cut). No
    // two-layer "powered by / runtime" framing.
    subtitle: "Your local coding agent is ready to join your First Tree team — let's set it up.",
    // Coding-agent picker (moved here from connect-computer): always a list, even
    // for one, default-selected to Claude Code when present. Verb-leading to
    // match the imperative `nameLabel` ("Name your agent") below; "local" keeps
    // the subtitle's vocabulary and frames the pick as the user's own
    // machine-side tool — connect-computer already showed which machine, so no
    // "Detected on <host>" sub-label is repeated here.
    codingAgentLabel: "Choose your local coding agent",
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
  },
  /** start-chat — one unified "launch" finale across every path. Titles/bodies are
      rendered per-state by the step; the shell leaves STEP_COPY["start-chat"] empty
      for this finale. */
  startChat: {
    // Every finale below shares one title + one subtitle + one button. The
    // per-state keys are kept because the step still selects them by path/state,
    // but they resolve to the same strings on purpose (see START_CHAT_LAUNCH_WHY):
    // the team/tree difference behind them is invisible to the user, so a
    // differentiated subtitle only leaked backend readiness they can't act on.

    // admin · new tree (the default — the team has none yet). `newWhy`/`existingWhy`
    // are only read by the dormant repo-aware branch (StepConnectCode is out of the
    // live sequence); kept as functions so that call site's shape is unchanged.
    newTitle: "Start working with your agent",
    newWhy: (_repoCount: number): string => START_CHAT_LAUNCH_WHY,
    startBuilding: "Start chat",

    // admin · the team already has a Context Tree (re-run / second admin /
    // CLI-bound). Detected silently; also part of the dormant repo-aware branch.
    existingTitle: "Start working with your agent",
    existingWhy: (_repoCount: number): string => START_CHAT_LAUNCH_WHY,
    startExisting: "Start chat",

    // admin · no repo connected (the live default path).
    noProjectTitle: "Start working with your agent",
    noProjectBody: START_CHAT_LAUNCH_WHY,
    startChatting: "Start chat",

    // invitee · ready (team has a tree + a GitHub connection). The agent inherits
    // the team's recommended repos automatically, so there is nothing to select.
    inviteeReadyTitle: "Start working with your agent",
    inviteeReadyBody: START_CHAT_LAUNCH_WHY,
    startWorking: "Start chat",

    // shared launch transition
    starting: "Starting your agent…",

    /** Heading of the community footer under the launch CTA (every finale).
     *  The channel cards themselves live in components/community-channels.tsx
     *  (shared with the top-bar SupportMenu), so only the onboarding-surface
     *  heading is copy here. */
    community: {
      title: "Join the community",
    },
  },
  /** invitee · join-team confirmation + the one not-ready (blocked-on-admin) state.
   *  The not-ready screen covers both "no Context Tree" and "no GitHub
   *  connection" — the invitee can't act on either, and it advances on its own
   *  once the admin finishes. */
  invitee: {
    welcomeBody: {
      pre: "You're joining ",
      post: ".",
    },
    notReadyTitle: "Start working with your agent",
    notReadyBody: START_CHAT_LAUNCH_WHY,
    // The primary action on the not-ready screen — start a simple first chat now
    // instead of waiting on the team.
    startAnyway: "Start chat",
  },
  /** get-started fork (invitee only): own agent vs team-agent quick start. */
  getStarted: {
    chooseTitle: "You're in. How do you want to start?",
    chooseWhy: "Both paths land you in the team — pick what fits right now.",
    own: {
      title: "Set up my own agent",
      description: "Connect your computer and create your personal agent — the full First Tree experience.",
      cta: "Continue setup",
    },
    quick: {
      title: "Take a quick look with a team agent",
      description:
        "Jump in now and chat with an agent your teammates already run — nothing to install. You can set up your own agent any time later.",
      cta: "Quick start",
    },
    pickTitle: "Pick a team agent",
    pickWhy: "Start chatting now. You can set up your own agent any time later.",
    /** Ownership tag on each row — descriptive wording, not a new product concept. */
    runBy: (owner: string) => `Run by ${owner}`,
    startChat: "Start chat",
    pickEmpty: "No team agent is available right now — set up your own instead.",
    /** Footnote under the list: quick start does not finish setup. */
    pickFootnote: "Starting here won't finish your setup — you can complete it any time from Settings.",
  },
  /** failure recovery, shared */
  errors: {
    generic: "Something went wrong. Try again in a moment.",
    chatFailed: "Couldn't start the first task. Try again.",
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
