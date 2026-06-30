import type { CampaignSlug } from "../quickstart/campaigns.js";

/**
 * Marketing copy for the scan landing page, keyed by campaign slug. Each
 * campaign in {@link CampaignSlug} that has a landing surface gets one entry;
 * the landing route (`/scan/:campaign`) renders this and points its CTA at
 * `/quickstart?campaign=<slug>&repo=<encoded>`.
 *
 * Kept separate from the quickstart `campaigns.ts` registry on purpose: that
 * registry drives runtime BEHAVIOUR (the first-chat bootstrap, idempotency),
 * whereas this is user-facing MARKETING copy. Claims stay accurate and
 * restrained — no superlatives the scan can't back up (mirrors the landing
 * `features.tsx` "keep value claims accurate" rule).
 */
export type ScanLandingCopy = {
  /** Decorative eyebrow above the headline; kept out of the heading outline. */
  eyebrow: string;
  /** The <h1>. One concrete question the visitor is already asking. */
  headline: string;
  /** One-line value promise. Specific, honest — names the payoff, not hype. */
  subhead: string;
  /** Primary CTA label on the green hero button. */
  ctaLabel: string;
  /** Placeholder for the repo URL input. */
  repoPlaceholder: string;
  /** Short label above the "what we look at" chips. */
  checksLabel: string;
  /** A few dimensions we score — credibility, not an exhaustive rubric. */
  checks: readonly string[];
};

export const SCAN_LANDING_COPY: Record<CampaignSlug, ScanLandingCopy> = {
  "production-scan": {
    eyebrow: "Production Readiness",
    headline: "Is your repo ready to ship?",
    subhead:
      "A free, security-weighted audit of the blockers most likely to stop your repo shipping — with evidence, not generic advice.",
    ctaLabel: "Scan my repo",
    repoPlaceholder: "https://github.com/your-org/your-repo",
    checksLabel: "What we look at",
    checks: ["Secrets & security", "Tests & CI", "Deploy & runtime", "Dependencies"],
  },
  "agent-readiness": {
    eyebrow: "Agent Readiness",
    headline: "Is your repo ready for coding agents?",
    subhead:
      "A free scan of why Claude Code, Codex & Cursor get lost in your repo — and the must-fix blockers to make it agent-ready.",
    ctaLabel: "Scan my repo",
    repoPlaceholder: "https://github.com/your-org/your-repo",
    checksLabel: "What we look at",
    checks: ["Agent instructions", "Verifiability", "Navigability", "Edit boundaries"],
  },
};
