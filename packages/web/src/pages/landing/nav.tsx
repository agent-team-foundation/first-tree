import { Link } from "react-router";
import { FirstTreeLogo } from "../../components/first-tree-logo.js";

/**
 * Top nav for the landing page.
 *
 * Deliberately stripped down: brand mark on the left, one secondary action
 * (Sign in) on the right. No anchor links — the landing page only has Hero
 * + Features so a section nav would just add visual noise.
 *
 * No theme toggle here on purpose: `.landing-marketing` pins the surface
 * to the first-tree.ai dark palette regardless of the dashboard's
 * `html.dark` class, so a toggle would look broken (no visible change)
 * while silently flipping the dashboard preference for the user's next
 * authenticated session — a UX trap.
 *
 * Landmark structure: <header> wraps the bar; the right-side control lives
 * inside a <nav aria-label="Primary"> so screen readers can jump straight
 * to Sign in without reading the brand mark first.
 */
export function LandingNav() {
  return (
    <header className="sticky top-0 z-10 border-b border-border/60 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-6">
        <Link
          to="/"
          aria-label="First Tree Hub home"
          className="flex items-center gap-2 rounded-[var(--radius-input)] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <FirstTreeLogo width={18} height={20} />
          <span className="text-title">
            First Tree <span className="font-normal text-fg-3">Hub</span>
          </span>
        </Link>
        <nav aria-label="Primary" className="flex items-center gap-2">
          <Link
            to="/login"
            className="inline-flex items-center rounded-[var(--radius-input)] px-3 py-1.5 text-body font-medium text-fg-2 transition-colors hover:bg-bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Sign in
          </Link>
        </nav>
      </div>
    </header>
  );
}
