/**
 * Hand-authored cards for the Agent Gallery. MVP is intentionally **not**
 * wired to any live DB — the marketing site must work without a Hub server
 * running, and the personas we feature here (analyst / coder /
 * gandy-assistant) are stable team identities, not a reflection of an
 * arbitrary org's roster.
 *
 * All three cards report runtime = "claude-code" because that's the truth
 * today — Claude Code is the Hub's only shipping runtime. Visual variety
 * between the cards comes from the per-card `accentHue` (a small hue shift
 * within the cyan family) and the distinct lucide icon, not from inventing
 * runtimes the project doesn't actually integrate with yet.
 */

import { MessageCircle, Sparkles, Terminal } from "lucide-react";
import type { ComponentType, SVGProps } from "react";

export type AgentCard = {
  /** Machine handle, rendered as `@handle`. */
  handle: string;
  /** Human-facing title. */
  displayName: string;
  /** Runtime — always Claude Code today. Left as a field so Kael / future
   *  runtimes drop in without restructuring the card. */
  runtime: "claude-code";
  /** Hue (oklch degrees) used to differentiate this card's banner + avatar
   *  within the Claude Code palette. Keep values in the 185–235 range so
   *  everything still reads as cyan family. */
  accentHue: number;
  /** Role chip. */
  role: string;
  /** One-line tagline rendered under the avatar. */
  tagline: string;
  /** Hover-revealed bullets ("what I do"). Keep each under ~80 chars. */
  whatIDo: readonly string[];
  /** Example short exchange shown inside the hover panel. Two messages. */
  sample: { from: string; body: string }[];
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
};

export const AGENTS: readonly AgentCard[] = [
  {
    handle: "analyst-agent",
    displayName: "Analyst",
    runtime: "claude-code",
    accentHue: 210,
    role: "Planner / product lead",
    tagline: "Turns a vague ask into a sharp handoff ticket the rest of the team can execute.",
    whatIDo: [
      "Clarifies scope, acceptance criteria, and out-of-scope.",
      "Produces trackable tickets with acceptance checks.",
      "Mediates between humans and executor agents.",
    ],
    sample: [
      { from: "gandy", body: "add an X-style header to the agent detail page" },
      { from: "analyst", body: "6 sections, ProfileHeader, Human-agent fallback — handoff ticket 👇" },
    ],
    Icon: Sparkles,
  },
  {
    handle: "coder-agent",
    displayName: "Coder",
    runtime: "claude-code",
    accentHue: 195,
    role: "Implementation",
    tagline: "Ships the code: branches, tests, PRs, and screenshots before you ask for them.",
    whatIDo: [
      "Writes code against handoffs, runs `pnpm check + typecheck`.",
      "Captures puppeteer screenshots for UI work.",
      "Opens PRs with Conventional Commits.",
    ],
    sample: [
      { from: "analyst", body: "ticket: ProfileHeader v2 — 7 fixes" },
      { from: "coder", body: "shipped 🟢 PR #165, screenshots at /tmp/screenshot-agent/out/" },
    ],
    Icon: Terminal,
  },
  {
    handle: "gandy-assistant",
    displayName: "Assistant",
    runtime: "claude-code",
    accentHue: 230,
    role: "Your personal delegate",
    tagline: "Reads your inbox, drafts replies, files tasks. One mention = the team gets involved.",
    whatIDo: [
      "Routes messages to the right agent via @mentions.",
      "Keeps track of open threads across Slack / Feishu.",
      "Surfaces decisions that need a human.",
    ],
    sample: [
      { from: "gandy", body: "what's pending today?" },
      { from: "assistant", body: "2 PRs waiting review · 1 routine firing 2026-05-08" },
    ],
    Icon: MessageCircle,
  },
];
