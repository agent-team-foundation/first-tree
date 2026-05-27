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

import type { OnboardingPath, StepId } from "./steps.js";

/**
 * A string that can either apply to both paths, or differ per path.
 * Use the object form when admin and invitee should see different copy on
 * the same logical step (currently only `kickoff` needs this — admin builds
 * a Context Tree, invitee just kicks off their own work).
 */
export type PathScopedString = string | { admin: string; invitee: string };

export function resolvePathScoped(value: PathScopedString, path: OnboardingPath): string {
  return typeof value === "string" ? value : value[path];
}

/** Convenience: pull a step's rail label for the given path. */
export function resolveStepLabel(step: StepId, path: OnboardingPath): string {
  return resolvePathScoped(STEP_COPY[step].label, path);
}

export type StepCopy = {
  /** Short label shown in the left progress rail. May vary by path. */
  label: PathScopedString;
  /** Heading at the top of the content column. */
  title: string;
  /** One plain-language sentence: why this step exists. */
  why: string;
};

export const STEP_COPY: Record<StepId, StepCopy> = {
  team: {
    label: "Welcome",
    title: "Name your team",
    why: "This is the shared space where you, your teammates, and your AI agents work together. Rename it anytime.",
  },
  "connect-code": {
    label: "Connect code",
    title: "Connect your code",
    why: "Connect your projects so your agent can read the code. Every change comes back as a request you review.",
  },
  "connect-computer": {
    label: "Connect computer",
    title: "Connect a computer",
    why: "Your agent needs a real computer — link one to your team so it has somewhere to run.",
  },
  "create-agent": {
    label: "Create agent",
    title: "Create your agent",
    why: "Name your agent and pick who can work with it. You'll be chatting in a moment, and you can add more anytime.",
  },
  kickoff: {
    label: { admin: "Start tree", invitee: "Start work" },
    // title/why are rendered per-state by StepKickoff (new / existing / no
    // project / invitee sub-states); the shell skips them while empty.
    title: "",
    why: "",
  },
  welcome: {
    label: "Welcome",
    title: "Welcome to the team",
    why: "Your team is already set up. Let's get your own agent working in a couple of quick steps.",
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
      "Code connection isn't set up on this server yet. You can continue now and connect a project later from Settings.",
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
    /** Returned from the install dialog without a new installation. */
    postAttemptStuckTitle: "Looks like the install didn't complete.",
    postAttemptStuckBody:
      "GitHub sent you back without adding First Tree. Try again, or get a link to send to your GitHub org owner.",
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
      "Your computer is connected, but it doesn't have an AI engine ready yet. Install one (like Claude Code) on that computer and sign in — then it'll show up here automatically.",
    detecting: "Checking what's installed…",
    stuckTitle: "Taking a while? A few common reasons:",
    stuckReasons: [
      "If you saw “command not found”, your computer needs Node.js first — it's a free install. Get it, then run the command again.",
      "Make sure you ran it on the computer you want your agent to use.",
      "A company firewall or VPN can sometimes block the connection.",
    ],
    nodeLinkLabel: "Install Node.js (free)",
    nodeUrl: "https://nodejs.org",
  },
  /** create-agent states */
  createAgent: {
    nameLabel: "What should we call your agent?",
    creating: "Setting up your agent…",
    creatingHint: "Usually about 10 seconds",
    timeoutTitle: "This is taking longer than expected.",
    timeoutBody:
      "Your agent was created, but it hasn't come online yet. The computer it runs on may have gone to sleep or lost its connection, or its AI engine couldn't start. Check that computer, then try again.",
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
    inviteePickerScopeMissing: "Couldn't see your projects — your GitHub access doesn't include project scope.",
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
      "Your team's admin set up the Context Tree but hasn't connected code on GitHub yet. Your agent needs this to do real work.",
    noInstallStatus: "Watching for the connection…",
    noInstallShareIntro: "Send this link to your admin to remind them:",
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
