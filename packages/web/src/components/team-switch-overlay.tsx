import { Loader2 } from "lucide-react";
import { useAuth } from "../auth/auth-context.js";

/**
 * Global team-switch transition veil. Reads `switchingOrg` from auth-context
 * (set by the TeamSwitcher) and, while a switch is in flight, covers the content
 * region below the header with one intentional "Switching to {name}…" overlay —
 * replacing the old flash where every org-scoped component blanked to its own
 * skeleton as the React-Query cache cleared. Mounted once by the layout; the
 * styling + reduced-motion fallback live in `.team-switch-veil` (index.css).
 */
export function TeamSwitchOverlay() {
  const { switchingOrg } = useAuth();
  if (!switchingOrg) return null;
  return (
    <div className="team-switch-veil" role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-body" style={{ color: "var(--fg-2)" }}>
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Switching to {switchingOrg.displayName}…</span>
      </div>
    </div>
  );
}
