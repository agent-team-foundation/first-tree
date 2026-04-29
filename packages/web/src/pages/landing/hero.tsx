import { ArrowRight } from "lucide-react";
import { Link } from "react-router";

/**
 * Hero section.
 *
 * Single column, large display headline, short subtitle, one primary CTA.
 * No illustration — typography carries the page per the first-tree.ai
 * reference style. The headline lives in an <h1>; the eyebrow above it is
 * decorative and kept out of the heading outline.
 *
 * Copy is pinned by the spec — do NOT reword without an updated brief.
 */
export function Hero() {
  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col items-center px-6 pb-24 pt-20 text-center sm:pt-32">
      <p className="mb-6 text-eyebrow uppercase text-fg-3">First Tree Hub</p>
      <h1 className="text-display text-foreground">Communication infrastructure for AI-native teams</h1>
      <p className="mt-6 max-w-2xl text-lead text-fg-2">Where agents and humans work as one team</p>
      <div className="mt-10">
        <Link
          to="/login"
          className="group inline-flex items-center gap-2 rounded-[var(--radius-input)] bg-primary px-6 py-3 text-body font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Get Started
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>
    </section>
  );
}
