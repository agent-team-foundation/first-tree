import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import { getGithubAppInstallation } from "../../api/github-app.js";
import { useAuth } from "../../auth/auth-context.js";
import { Button } from "../../components/ui/button.js";
import { Section } from "../../components/ui/section.js";
import { GithubAppInstallationPanel } from "../github-app-installation-panel.js";

/**
 * Settings → Integrations → GitHub. Members can read the team's GitHub
 * connection; admin-only actions stay hidden in the installation panel. Team
 * code access is provider-neutral and lives in the shared Integrations layout
 * above the GitHub/GitLab connection tabs.
 *
 * `?from=context`: the Context tab is the single place a team builds its
 * Context Tree, but installing + connecting GitHub lives here (the one place
 * that binds an installation to the team). When the Context tab sends the user
 * here to connect, we mark the trip so this page can hand them back — a return
 * CTA appears the moment the team is connected, so they don't have to find
 * their own way back to building.
 */
export function SettingsGithubPage() {
  const { role, organizationId } = useAuth();
  const [searchParams] = useSearchParams();
  const fromContext = searchParams.get("from") === "context";

  // Only needed to drive the "back to building" return for the Context round
  // trip. Shares the query key the connection panel invalidates on connect, so
  // this flips to connected the moment the user finishes connecting below.
  const installationQuery = useQuery({
    queryKey: ["github-app-installation", organizationId],
    queryFn: () => (organizationId ? getGithubAppInstallation(organizationId) : Promise.reject(new Error("no org"))),
    enabled: fromContext && !!organizationId,
  });
  const connected = installationQuery.data != null;

  if (role === null) {
    return (
      <div className="text-body" style={{ padding: "var(--sp-5)", color: "var(--fg-3)" }}>
        Loading...
      </div>
    );
  }
  const isAdmin = role === "admin";

  // Page heading + lead are owned by the Settings layout (see settings.tsx).
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-5)", padding: "var(--sp-2) var(--sp-5) var(--sp-7)" }}>
      {fromContext ? <ContextReturn connected={connected} /> : null}
      <Section title="Connection">
        <GithubAppInstallationPanel readOnly={!isAdmin} />
      </Section>
    </div>
  );
}

/**
 * The Context round-trip return. Before the team is connected it's a quiet line
 * explaining why the user was sent here; once connected it becomes the explicit
 * way back to building (deliberately a button, not an auto-redirect, so the user
 * stays in control and can adjust shared code access above first if they want).
 */
function ContextReturn({ connected }: { connected: boolean }) {
  if (!connected) {
    return (
      <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
        Connect GitHub below, then head back to build your team's Context Tree.
      </p>
    );
  }
  return (
    <div
      className="flex flex-col"
      style={{
        gap: "var(--sp-2)",
        padding: "var(--sp-3)",
        borderRadius: "var(--radius-panel)",
        background: "var(--color-success-soft)",
      }}
    >
      <div className="flex items-center text-body" style={{ gap: "var(--sp-2)", color: "var(--fg)" }}>
        <Check className="h-4 w-4" style={{ color: "var(--color-success)" }} aria-hidden />
        <span>GitHub is connected.</span>
      </div>
      <div className="flex">
        <Button asChild variant="cta">
          <Link to="/context">
            <span>Back to building your Context Tree</span>
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </Button>
      </div>
    </div>
  );
}
