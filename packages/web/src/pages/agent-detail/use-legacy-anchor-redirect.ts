import { useEffect } from "react";
import { useLocation, useNavigate, useParams } from "react-router";

/**
 * Redirect legacy hash anchors to the new tab routes. Kept permanently — the
 * cost is negligible and old in-app links / pasted URLs / bookmarks survive
 * the redesign indefinitely.
 *
 * Old anchor IDs come from the pre-tab agent-detail layout (`SECTION_ANCHORS`
 * constants and the per-section `agent-cfg-*` ids emitted by `save-bar.tsx`).
 */
const HASH_TO_TAB: Record<string, string> = {
  "ad-overview": "profile",
  "ad-appearance": "profile",
  "ad-setup": "runtime",
  "ad-prompt": "prompt",
  "agent-cfg-prompt": "prompt",
  "agent-cfg-mcp": "profile",
  "ad-advanced": "resources",
  "agent-cfg-env": "resources",
  "agent-cfg-git": "resources",
  // Lifecycle lives at the bottom of Profile — keep the danger anchor alive.
  "ad-danger": "profile",
};

export function useLegacyAnchorRedirect(): void {
  const navigate = useNavigate();
  const location = useLocation();
  const { uuid } = useParams<{ uuid: string }>();

  useEffect(() => {
    if (!uuid) return;
    const hash = location.hash.replace(/^#/, "");
    if (!hash) return;
    const tab = HASH_TO_TAB[hash];
    if (!tab) return;
    navigate(`/agents/${uuid}/${tab}`, { replace: true });
  }, [uuid, location.hash, navigate]);
}
