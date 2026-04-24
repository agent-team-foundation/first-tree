import { AgentGallery } from "../sections/agent-gallery.js";
import { Hero } from "../sections/hero.js";
import { StickyNav } from "../sections/sticky-nav.js";

/**
 * Single-route marketing landing page. MVP ships Hero + Agent Gallery;
 * later sections (Architecture, How-it-works, Features, Community, Footer)
 * layer in behind feature-branches without changing this file's shape.
 */
export function LandingPage() {
  return (
    <>
      <StickyNav />
      <main>
        <Hero />
        <AgentGallery />
      </main>
    </>
  );
}
