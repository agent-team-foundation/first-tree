/**
 * Every user-facing string in the onboarding flow, in one place.
 *
 * Goal: a complete beginner — someone who has never heard "repo", "runtime",
 * "context tree", or "binding" — can read these and know what to do and why.
 * The vocabulary is deliberately small: "team", "your code", "a computer",
 * "AI teammate", "team knowledge". Implementation words never leak into the
 * UI; they stay in code and in the agent-facing bootstrap prose.
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
  /** What the user will have once this step is done (shown in the side panel). */
  outcomes: readonly string[];
};

export const STEP_COPY: Record<StepId, StepCopy> = {
  team: {
    label: "Your team",
    title: "Name your team",
    why: "This is the shared space where you, your teammates, and your AI teammates work together.",
    outcomes: ["A team others can join", "You can rename it or invite people anytime"],
  },
  "connect-code": {
    label: "Your code",
    title: "Connect your code",
    why: "Give your AI teammate access to a project so it can actually help — read the code, suggest changes, and open requests for you to review.",
    outcomes: [
      "Your AI teammate can see the project you pick",
      "Nothing ships without you — every change comes back as a request you approve",
    ],
  },
  "connect-computer": {
    label: "Your computer",
    title: "Connect a computer",
    why: "Your AI teammate runs on a real computer — yours or a shared one — so it can do real work, not just chat.",
    outcomes: ["A computer linked to your team", "Somewhere for your AI teammate to run"],
  },
  "create-agent": {
    label: "AI teammate",
    title: "Create your AI teammate",
    why: "Add an AI member to your team. Give it a name and choose who can work with it.",
    outcomes: ["Your first AI teammate, ready to talk", "You can add more teammates later"],
  },
  kickoff: {
    label: "Get started",
    title: "Set up your team knowledge",
    why: "Give your AI teammate a shared knowledge base about your project, so it works with real context instead of starting from scratch every time.",
    outcomes: [
      "A shared knowledge base your team and its AI teammates build on",
      "Your AI teammate starts its first task and tells you what to review",
    ],
  },
  welcome: {
    label: "Welcome",
    title: "Welcome to the team",
    why: "Your team is already set up. Let's get your own AI teammate working in a couple of quick steps.",
    outcomes: ["You're in the team", "Next: connect a computer and create your AI teammate"],
  },
};

/** Shared phrases reused across steps so wording stays consistent. */
export const COPY = {
  /** Title shown across the flow's top chrome. */
  productName: "First Tree",
  flowEyebrow: "Getting started",
  continue: "Continue",
  back: "Back",
  skipForNow: "Skip for now",
  finishLater: "I'll finish later",
  hideSetup: "Hide setup",
  /** Generic reassurance shown wherever GitHub access is requested. */
  reviewReassurance: "We never change your code without asking — every change comes back as a request you review.",
  /** connect-code states */
  connectCode: {
    intro: "Your code lives on GitHub. Connect it so your AI teammate can read your project and help with it.",
    cta: "Connect on GitHub",
    waiting: "Waiting for GitHub…",
    connected: "Connected",
    pickProject: "Which project should your AI teammate help with?",
    noRepos: "No projects found on your GitHub account yet.",
    reconnect: "Reconnect GitHub with project access",
    notConfigured:
      "Code connection isn't set up on this server yet. You can continue now and connect a project later from Settings.",
    notAdmin: "Only a team admin can connect code. Ask an admin to finish this, or continue for now.",
    continueWithout: "Continue without connecting code",
    continueNoProject: "Continue without a project",
    pickHint: "Pick the project your AI teammate should help with — or continue without one for now.",
  },
  /** connect-computer states */
  connectComputer: {
    instruction:
      "On the computer your AI teammate will use, open Terminal (on a Mac) or PowerShell (on Windows), then paste this and press Enter:",
    waiting: "Waiting for your computer…",
    connected: "connected",
    noRuntime:
      "Your computer is connected, but it doesn't have an AI engine ready yet. Install one (like Claude Code) on that computer and sign in — then it'll show up here automatically.",
    detecting: "Checking what's installed…",
    stuckTitle: "Taking a while? A few common reasons:",
    stuckReasons: [
      "If you saw “command not found”, your computer needs Node.js first — it's a free install. Get it, then run the command again.",
      "Make sure you ran it on the computer you want your AI teammate to use.",
      "A company firewall or VPN can sometimes block the connection.",
    ],
    nodeLinkLabel: "Install Node.js (free)",
    nodeUrl: "https://nodejs.org",
  },
  /** create-agent states */
  createAgent: {
    nameLabel: "What should we call your AI teammate?",
    creating: "Setting up your AI teammate…",
    creatingHint: "Usually about 10 seconds",
    timeoutTitle: "This is taking longer than expected.",
    timeoutBody:
      "Your AI teammate was created, but it hasn't come online yet. The computer it runs on may have gone to sleep or lost its connection, or its AI engine couldn't start. Check that computer, then try again.",
    retry: "Try again",
  },
  /** kickoff states */
  kickoff: {
    createBlurb:
      "We'll set up a shared knowledge base for your project automatically — your AI teammate does the work, and you review the result.",
    haveExisting: "I already have team knowledge",
    createInstead: "Create new instead",
    existingUrlLabel: "Team knowledge link",
    start: "Start",
    starting: "Getting your AI teammate started…",
    invalidUrl:
      "That doesn't look like a web link — paste the full address, e.g. https://github.com/your-team/knowledge",
  },
  /** invitee states */
  invitee: {
    waitingTitle: "Your team is still being set up",
    waitingBody:
      "An admin hasn't finished setting up your team's code and knowledge base yet. This page updates on its own once they're done — or you can start chatting in the meantime.",
    confirmTitle: "Your team is ready",
    confirmBody: "Your team already set up its projects and knowledge base. Pick what your AI teammate should work on.",
  },
  /** failure recovery, shared */
  errors: {
    generic: "Something went wrong. Try again in a moment.",
    chatFailed: "Couldn't start the first task. Try again.",
    agentFailed: "Couldn't create your AI teammate. Try again.",
    noAgent: "We couldn't find your AI teammate. Go back a step and create one.",
  },
} as const;
