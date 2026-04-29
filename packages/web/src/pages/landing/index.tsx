import { useEffect } from "react";
import { Features } from "./features.js";
import { Footer } from "./footer.js";
import { Hero } from "./hero.js";
import { LandingNav } from "./nav.js";

/**
 * Public-facing landing page.
 *
 * Rendered by `RequireAuth` whenever an unauthenticated visitor hits `/`
 * (authenticated users go straight to the WorkspacePage as before). The page
 * is intentionally minimal — three sections, no illustrations, restrained
 * accent — to mirror the typographic style of first-tree.ai.
 *
 * Title is patched on mount and restored on unmount so authenticated tabs
 * (which mount the dashboard chrome instead) don't see the marketing string
 * in their title bar after a logout → login round-trip.
 */
export function LandingPage() {
  useEffect(() => {
    const previous = document.title;
    document.title = "First Tree Hub — Communication infrastructure for AI-native teams";
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    // `landing-marketing` swaps the local --bg/--fg/--border tokens to the
    // first-tree.ai palette (near-black + cool-light), shared with the parent
    // brand. Scoping it here means the dashboard chrome stays unaffected.
    <div className="landing-marketing flex min-h-screen flex-col bg-background text-foreground">
      <LandingNav />
      <main className="flex-1">
        <Hero />
        <Features />
      </main>
      <Footer />
    </div>
  );
}
