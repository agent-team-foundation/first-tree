/**
 * Every user-facing string in the onboarding flow, in one place.
 *
 * Goal: a complete beginner — someone who has never heard "repo", "runtime",
 * or "binding" — can read these and know what to do and why.
 * The vocabulary is deliberately small: "team", "your project", "a computer",
 * "agent", "Context Tree". We distinguish people from AI: human members are
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
    title: "Connect your code",
    why: "Connect your projects so your agent can read the code. Every change comes back as a request you review.",
  },
  "connect-computer": {
    title: "Connect your computer",
    why: "Run the command below on the computer where your agent should run.",
  },
  "create-agent": {
    // "an agent", not "your agent": it can be team-visible (see the Visibility
    // choice), so "your" would over-claim private ownership. No `why` — the
    // title + form are self-explanatory; a subtitle would only restate fields.
    title: "Create an agent",
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
    cta: "Install First Tree on GitHub",
    waiting: "Waiting for GitHub…",
    connected: "Connected",
    pickProject: "Which projects should your agent work on?",
    noRepos: "No projects found on your GitHub account yet.",
    reconnect: "Reconnect GitHub with project access",
    notConfigured:
      "Code connection isn't set up here yet. You can continue now and connect a project later from Settings.",
    notAdmin: "Only a team admin can connect code. Ask an admin to finish this, or continue for now.",
    continueWithout: "Continue without connecting code",
    continueNoProject: "Continue without a project",
    pickHint: "Pick one or more projects for your agent — or continue without any for now.",
    /**
     * Non-owner hint shown under the primary CTA. We deliberately don't hand
     * out a copy-the-install-link button — GitHub's install URL is bound to
     * a per-browser `oauth_state_nonce` cookie, so a link opened in someone
     * else's browser would fail the callback. GitHub already routes
     * non-owner installs through an owner-approval flow, so the right
     * advice is to click Install anyway and let GitHub handle the ask.
     */
    notOwnerHint: "Not a GitHub organization owner? Click Install anyway — GitHub will ask an owner to approve.",
    /** Connected but GitHub access lacks repo scope — explain; the link carries the verb. */
    scopeMissing: "Couldn't see your projects — your GitHub access is missing project read permission.",
    /**
     * Replaces the "Waiting for GitHub…" status once the user returns from the
     * install dialog without an installation (postAttemptStuck). Guidance-y, so
     * the auto-opened "Need help?" below isn't missed — not a flat "still
     * waiting" (which would contradict the help saying it didn't go through).
     */
    stuckStatus: "Still don't see an install — the steps under Need help? can get you unstuck.",
    /**
     * Troubleshooting shown inside the "Need help?" disclosure (alongside the
     * InstallGuide how-to), mirroring connect-computer. The disclosure
     * auto-opens when the user returns from GitHub without an installation, so
     * the title is state-neutral (it can also be opened proactively).
     */
    troubleshootTitle: "If GitHub didn't add First Tree:",
    troubleshootBody: "Click Install again — it'll ask an org owner to approve if you're not one.",
    /** Skip-for-now confirm: primary action keeps the user on the connect path. */
    keepConnecting: "Keep connecting",
    /** Skip-for-now warning. */
    skipWarningTitle: "Skip connecting code?",
    skipWarningBullets: [
      "Your teammates' agents won't be able to read code (they'll hit errors)",
      "Your first agent will start with just an intro chat",
      "You can connect code later from Settings",
    ],
    skipAnyway: "Skip anyway",
  },
  /** connect-computer states */
  connectComputer: {
    waiting: "Waiting for your computer…",
    connected: "connected",
    noRuntime:
      "Your computer is connected, but it doesn't have an AI coding tool ready yet. Install one (like Claude Code) on that computer and sign in — then it'll show up here automatically.",
    detecting: "Checking what's installed…",
    stuckTitle: "Taking a while? A few common reasons:",
    stuckReasons: [
      "If you saw “command not found”, your computer needs Node.js first — it's a free install. Get it, then run the command again.",
      "Make sure you ran it on the computer you want your agent to use.",
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
    nameLabel: "What should we call your agent?",
    creating: "Setting up your agent…",
    creatingHint: "Usually about 10 seconds",
    timeoutTitle: "This is taking longer than expected.",
    timeoutBody:
      "Your agent was created, but it hasn't come online yet. The computer it runs on may have gone to sleep or lost its connection, or its AI coding tool couldn't start. Check that computer, then try again.",
    retry: "Try again",
  },
  /** kickoff / "Start" states (title/why are per-state, rendered by the step) */
  kickoff: {
    // admin — new Context Tree (default when the team has none yet)
    newTitle: "Start building your Context Tree",
    newWhy:
      "You're all set. Your agent builds your team's Context Tree with you in the chat, walking you through each change to approve.",
    haveExisting: "I already have a Context Tree",
    // admin — existing Context Tree (auto-detected from team settings, or pasted)
    existingTitle: "Use your team's Context Tree",
    existingWhy:
      "Your team already has a Context Tree — your agent will build on it, walking you through each change to approve in the chat.",
    existingUrlLabel: "Context Tree link",
    autoDetectedNote: "Your team already has one — your agent will build on it. Edit the link or create a new one.",
    createInstead: "Create new instead",
    // admin — no project connected
    noProjectTitle: "Start your agent",
    noProjectBody:
      "No project connected, so your agent will start with a quick intro. Connect a project later from Settings to give it real context.",
    // invitee — team's tree is ready, pick a project
    inviteePickerTitle: "Pick a project to work on",
    inviteePickerWhy: "Your team's set up — pick which of your own projects your agent should help with.",
    inviteePickerEmpty:
      "No projects found on your GitHub account yet. You can continue without one and add later from Settings.",
    inviteePickerScopeMissing: "Couldn't see your projects — your GitHub access is missing project read permission.",
    inviteePickerNetworkError: "Couldn't load your projects. Try again in a moment.",
    inviteeContinueNoProject: "Continue without a project",
    /** Shown atop confirm / picker so invitee knows where the work lands. */
    treeLabel: "Context Tree",
    start: "Start",
    starting: "Starting your agent…",
    invalidUrl:
      "That doesn't look like a web link — paste the full address, e.g. https://github.com/your-team/context-tree",
  },
  /** invitee states */
  invitee: {
    waitingTitle: "Waiting for your team to set up",
    waitingBody:
      "Your team's admin is still setting up projects and a Context Tree. This page updates on its own as soon as they're done.",
    waitingStatus: "Watching for updates…",
    // NEW: admin set up tree but never connected the GitHub App. Without
    // an installation, every git op the agent runs will 403, so we hard-stop
    // the invitee here rather than letting them sail into the picker.
    noInstallTitle: "Almost there — your team's code isn't connected yet",
    noInstallBody:
      "Your team's admin set up the Context Tree but hasn't connected code on GitHub yet. Your agent needs that connection to do real work.",
    noInstallStatus: "Watching for the connection…",
    noInstallShareIntro: "Send this link so your admin can connect your team's code:",
    confirmTitle: "Your team is ready",
    confirmBody: "Your team set up its projects and Context Tree. Pick what your agent should work on.",
    startAnyway: "Start chatting anyway",
  },
  /** failure recovery, shared */
  errors: {
    generic: "Something went wrong. Try again in a moment.",
    chatFailed: "Couldn't start the first task. Try again.",
    agentFailed: "Couldn't create your agent. Try again.",
    noAgent: "We couldn't find your agent. Go back a step and create one.",
  },
} as const;
