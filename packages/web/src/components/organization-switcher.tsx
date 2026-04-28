import type { OrgBrief } from "@agent-team-foundation/first-tree-hub-shared";
import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../api/client.js";
import { useAuth } from "../auth/auth-context.js";

/**
 * Compact org switcher for the top bar. Designed to be cheap when there's
 * only a single org (the v1 majority) — no dropdown overhead, just a
 * static label. Multi-org users get a dropdown with a "Create another team"
 * + "Join with link" entry at the bottom.
 *
 * The "team" copy in user-facing labels is intentional — backend / DB calls
 * everything `organization`, but the UI sticks with `team` because that's
 * what users say (proposal §"Naming convention").
 */
export function OrganizationSwitcher() {
  const { organizationId, adoptTokens } = useAuth();
  const navigate = useNavigate();
  const [orgs, setOrgs] = useState<OrgBrief[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void (async () => {
      try {
        const list = await api.get<OrgBrief[]>("/me/organizations");
        setOrgs(list);
      } catch {
        // best-effort — keep showing the static label
      }
    })();
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (open && ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  const current = orgs.find((o) => o.id === organizationId);
  const label = current?.displayName ?? "Team";

  const handleSwitch = async (id: string) => {
    try {
      const tokens = await api.post<{ accessToken: string; refreshToken: string }>("/auth/switch-org", {
        organizationId: id,
      });
      await adoptTokens(tokens);
      setOpen(false);
      navigate("/", { replace: true });
    } catch {
      // surface in console; keep dropdown open so the user can retry
    }
  };

  // Single-org users get a static label — no chevron, no overhead.
  if (orgs.length <= 1) {
    return (
      <div className="text-label text-muted-foreground" data-testid="org-switcher-static">
        {label}
      </div>
    );
  }

  return (
    <div ref={ref} className="relative" data-testid="org-switcher">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-label text-muted-foreground hover:bg-accent"
      >
        {label}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-60 rounded-md border bg-popover p-1 shadow-md">
          {orgs.map((o) => (
            <button
              type="button"
              key={o.id}
              onClick={() => void handleSwitch(o.id)}
              className={`block w-full rounded px-2 py-1 text-left text-label hover:bg-accent ${
                o.id === organizationId ? "font-semibold" : ""
              }`}
            >
              {o.displayName}
            </button>
          ))}
          <div className="my-1 h-px bg-border" />
          <button
            type="button"
            className="block w-full rounded px-2 py-1 text-left text-label hover:bg-accent"
            onClick={() => {
              setOpen(false);
              navigate("/setup?action=create");
            }}
          >
            + Create another team
          </button>
          <button
            type="button"
            className="block w-full rounded px-2 py-1 text-left text-label hover:bg-accent"
            onClick={() => {
              setOpen(false);
              navigate("/setup?action=join");
            }}
          >
            + Join with link
          </button>
        </div>
      )}
    </div>
  );
}
