import { ChevronDown, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../auth/auth-context.js";

/**
 * Top-bar dropdown for switching between workspaces (P1-9 in
 * docs/saas-onboarding-journey.md §6.2). Shows the current workspace's
 * display name; clicking opens the list. Selecting a different
 * workspace calls `switchWorkspace` (re-issues a per-org JWT pair),
 * then `refetchAll` brings the in-memory state in line.
 *
 * "Create another workspace" link routes to `/setup` — the same modal
 * the brand-new SaaS user sees, just rendered for an existing per-org
 * caller. After /setup completes the auth-context is in the new
 * workspace's per-org context.
 *
 * Hidden for users with exactly one workspace — there's nothing to
 * switch to, and the "Create another" affordance lives on /setup
 * which they can reach via a direct URL.
 */
export function WorkspaceSwitcher() {
  const navigate = useNavigate();
  const { workspaces, organizationId, switchWorkspace, refetchAll } = useAuth();
  const [open, setOpen] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click. Fires on every open-state mount; cleans up.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!workspaces || workspaces.length === 0) return null;
  const current = workspaces.find((w) => w.organizationId === organizationId);
  // Hide for the single-workspace case — no useful switch and no clutter
  // in the top bar. Users who want to create a second workspace can
  // navigate to /setup directly.
  if (workspaces.length <= 1) {
    return (
      <span className="text-body" style={{ color: "var(--fg-3)", padding: "var(--sp-1) var(--sp-2)" }}>
        {current?.organizationDisplayName ?? "Workspace"}
      </span>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center transition-colors text-body"
        style={{
          gap: 6,
          padding: "var(--sp-1) var(--sp-2)",
          color: "var(--fg)",
          borderRadius: "var(--radius-input)",
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{current?.organizationDisplayName ?? "Workspace"}</span>
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute right-0 z-10 mt-1 min-w-[14rem] rounded-md border border-border bg-card shadow-md"
          style={{ padding: "var(--sp-1)" }}
        >
          {switchError && (
            <div
              role="alert"
              className="rounded-md text-caption text-destructive"
              style={{
                padding: "var(--sp-1) var(--sp-2)",
                marginBottom: "var(--sp-1)",
                background: "color-mix(in srgb, var(--state-error) 12%, transparent)",
              }}
            >
              {switchError}
            </div>
          )}
          {workspaces.map((w) => (
            <button
              key={w.organizationId}
              type="button"
              role="option"
              aria-selected={w.organizationId === organizationId}
              onClick={async () => {
                if (w.organizationId === organizationId) {
                  setOpen(false);
                  return;
                }
                setSwitchError(null);
                try {
                  await switchWorkspace(w.organizationId);
                  setOpen(false);
                  // Drop the user back at the workspace root so any
                  // route param scoped to the previous org (e.g.
                  // /agents/:uuid) doesn't 404 in the new context.
                  navigate("/", { replace: true });
                } catch (err) {
                  // Surface inline rather than dropping the failure on
                  // the floor — the caller may have lost membership in
                  // the target workspace (403 from /auth/switch-org).
                  // Force a workspaces refetch so the dropdown reflects
                  // the post-failure list.
                  setSwitchError(err instanceof Error ? err.message : "Could not switch workspace");
                  void refetchAll();
                }
              }}
              className="block w-full text-left text-body transition-colors hover:bg-[color:var(--bg-sunken)]"
              style={{
                padding: "var(--sp-1) var(--sp-2)",
                borderRadius: "var(--radius-input)",
                color: w.organizationId === organizationId ? "var(--fg-3)" : "var(--fg)",
                cursor: w.organizationId === organizationId ? "default" : "pointer",
              }}
            >
              {w.organizationDisplayName}
              <span className="ml-2 text-caption" style={{ color: "var(--fg-3)" }}>
                {w.organizationName}
              </span>
            </button>
          ))}
          <div style={{ borderTop: "var(--hairline) solid var(--border)", marginTop: "var(--sp-1)" }} />
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              navigate("/setup");
            }}
            className="flex w-full items-center gap-2 text-body transition-colors hover:bg-[color:var(--bg-sunken)]"
            style={{
              padding: "var(--sp-1) var(--sp-2)",
              borderRadius: "var(--radius-input)",
              color: "var(--fg-3)",
            }}
          >
            <Plus className="h-3 w-3" />
            Create or join another workspace
          </button>
        </div>
      )}
    </div>
  );
}
