import { useEffect, useState } from "react";

/**
 * Workspace responsive breakpoint used by `Layout` (top-bar collapse) and
 * `WorkspacePage` (conversation-list + chat-details overlay behavior).
 *
 *   - `xl`     ≥ 80rem  : top bar + conv list + chat details all visible.
 *   - `md`     48–80rem : top bar drops right controls; chat details
 *                          collapse (still summon-able via its toggle).
 *   - `narrow` < 48rem  : top bar drops brand too (tabs only); both
 *                          side rails collapse; conv list is summon-able
 *                          via a hamburger in chat-view's header.
 *
 * Breakpoints align with Tailwind defaults (`md` = 48rem, `xl` = 80rem) —
 * the same values already used elsewhere in the dashboard. Expressed in
 * rem so the design-token guardrail (no raw `Npx`) stays clean.
 *
 * SPA-only: the SSR fallback seeds `xl` so the chrome lays out the wide
 * three-pane structure on first paint. SSR consumers (none today) would
 * need to override the seed to avoid a narrow-device hydration flicker.
 */
export type WorkspaceViewport = "xl" | "md" | "narrow";

const XL_QUERY = "(min-width: 80rem)";
const MD_QUERY = "(min-width: 48rem)";

function readViewport(): WorkspaceViewport {
  if (typeof window === "undefined") return "xl";
  if (window.matchMedia(XL_QUERY).matches) return "xl";
  if (window.matchMedia(MD_QUERY).matches) return "md";
  return "narrow";
}

export function useWorkspaceViewport(): WorkspaceViewport {
  const [viewport, setViewport] = useState<WorkspaceViewport>(readViewport);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const xlQuery = window.matchMedia(XL_QUERY);
    const mdQuery = window.matchMedia(MD_QUERY);
    const update = () => setViewport(readViewport());
    xlQuery.addEventListener("change", update);
    mdQuery.addEventListener("change", update);
    return () => {
      xlQuery.removeEventListener("change", update);
      mdQuery.removeEventListener("change", update);
    };
  }, []);

  return viewport;
}
