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
  /** Short label shown in the left progress rail. */
  label: string;
  /** Heading at the top of the content column. */
  title: string;
  /** One plain-language sentence: why this step exists. */
  why: string;
  /** What the user will have once this step is done (shown in the footer). */
  outcomes: readonly string[];
};

export const STEP_COPY: Record<StepId, StepCopy> = {
  team: {
    label: "Your team",
    title: "Name your team",
    why: "This is the shared space where you, your teammates, and your AI agents work together.",
    outcomes: ["A team others can join", "You can rename it or invite people anytime"],
  },
  "connect-code": {
    label: "Your projects",
    title: "Connect your projects",
    why: "Your agent is ready — now give it something to work on. Connect one or more projects and it can read the code, suggest changes, and open requests for you to review.",
    outcomes: [
      "Your agent can see the projects you pick",
      "Nothing ships without you — every change comes back as a request you approve",
    ],
  },
  "connect-computer": {
    label: "Your computer",
    title: "Connect a computer",
    why: "Your agent runs on a real computer — yours or a shared one — so it can do real work, not just chat.",
    outcomes: ["A computer linked to your team", "Somewhere for your agent to run"],
  },
  "create-agent": {
    label: "Your agent",
    title: "Create your agent",
    why: "Add an AI agent to your team — give it a name and choose who can work with it.",
    outcomes: ["Your first agent, ready to talk", "You can add more agents later"],
  },
  kickoff: {
    label: "Your Context Tree",
    // title/why are rendered per-state by StepKickoff (new / existing / no
    // project / invitee sub-states); the shell skips them while empty.
    title: "",
    why: "",
    outcomes: [
      "Your agent opens its first changes for you to review",
      "A shared Context Tree your team and its agents build on over time",
    ],
  },
  welcome: {
    label: "Welcome",
    title: "Welcome to the team",
    why: "Your team is already set up. Let's get your own agent working in a couple of quick steps.",
    outcomes: ["You're in the team", "Next: connect a computer and create your agent"],
  },
};

/** Shared phrases reused across steps so wording stays consistent. */
export const COPY = {
  /** Title shown across the flow's top chrome. */
  productName: "First Tree",
  continue: "Continue",
  back: "Back",
  skipForNow: "Skip for now",
  finishLater: "I'll finish later",
  hideSetup: "Hide setup",
  /** Generic reassurance shown wherever GitHub access is requested. */
  reviewReassurance: "We never change your code without asking — every change comes back as a request you review.",
  /** connect-code states */
  connectCode: {
    intro: "Your project's code lives on GitHub. Connect it so your agent can read it and help with it.",
    cta: "Connect on GitHub",
    waiting: "Waiting for GitHub…",
    connected: "Connected",
    pickProject: "Which projects should your agent work on?",
    noRepos: "No projects found on your GitHub account yet.",
    reconnect: "Reconnect GitHub with project access",
    notConfigured:
      "Code connection isn't set up on this server yet. You can continue now and connect a project later from Settings.",
    notAdmin: "Only a team admin can connect code. Ask an admin to finish this, or continue for now.",
    alreadyInstalledHint:
      "Already added First Tree on GitHub? Connecting again just links it to this team — nothing is reinstalled.",
    continueWithout: "Continue without connecting code",
    continueNoProject: "Continue without a project",
    pickHint: "Pick one or more projects for your agent — or continue without any for now.",
  },
  /** connect-computer states */
  connectComputer: {
    instruction:
      "On the computer your agent will use, open Terminal (on a Mac) or PowerShell (on Windows), then paste this and press Enter:",
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
      "You're all set. Your agent builds your Context Tree with you in the chat, walking you through each change to approve.",
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
    inviteePickerTitle: "Your team's Context Tree is ready",
    inviteePickerWhy: "Pick a project for your agent to work on.",
    start: "Start",
    starting: "Starting your agent…",
    invalidUrl:
      "That doesn't look like a web link — paste the full address, e.g. https://github.com/your-team/context-tree",
  },
  /** invitee states */
  invitee: {
    waitingTitle: "Your team is still being set up",
    waitingBody:
      "An admin hasn't finished setting up your team's projects and Context Tree yet. This page updates on its own once that's done — or you can start chatting in the meantime.",
    confirmTitle: "Your team is ready",
    confirmBody: "Your team already set up its projects and Context Tree. Pick what your agent should work on.",
  },
  /** failure recovery, shared */
  errors: {
    generic: "Something went wrong. Try again in a moment.",
    chatFailed: "Couldn't start the first task. Try again.",
    agentFailed: "Couldn't create your agent. Try again.",
    noAgent: "We couldn't find your agent. Go back a step and create one.",
  },
} as const;
