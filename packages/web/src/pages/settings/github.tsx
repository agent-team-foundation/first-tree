import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { getGithubAppInstallation } from "../../api/github-app.js";
import { useAuth } from "../../auth/auth-context.js";
import { Button } from "../../components/ui/button.js";
import { Section } from "../../components/ui/section.js";
import { clearGithubAccountLinkReturn, readGithubAccountLinkReturn } from "../../lib/github-account-link-return.js";
import { clearGithubInstallAttempt, readGithubInstallAttempt } from "../../lib/github-install-attempt.js";
import { GithubAppInstallationPanel } from "../github-app-installation-panel.js";
import { GithubTaskAgentControls } from "./github-task-agent-controls.js";

const CONNECTION_HASH = "#connection";
const TASK_ROUTING_HASH = "#task-routing";

type GithubReturnContext = {
  kind: "account-link" | "install";
  organizationId: string;
  consumeBeforePanel: boolean;
};

function readGithubReturnContext(
  completedAccountLink: boolean,
  errorCode: string | null,
  flow: string | null,
): GithubReturnContext | null {
  if (!completedAccountLink && errorCode === null) {
    const installReturn = readGithubInstallAttempt();
    return installReturn
      ? { kind: "install", organizationId: installReturn.organizationId, consumeBeforePanel: false }
      : null;
  }
  if (completedAccountLink || flow === "link") {
    const accountLinkReturn = readGithubAccountLinkReturn();
    return accountLinkReturn
      ? { kind: "account-link", organizationId: accountLinkReturn.organizationId, consumeBeforePanel: true }
      : null;
  }
  if (flow === "install") {
    const installReturn = readGithubInstallAttempt();
    return installReturn
      ? { kind: "install", organizationId: installReturn.organizationId, consumeBeforePanel: true }
      : null;
  }

  // Rolling compatibility for error URLs created before `flow` was added.
  const accountLinkReturn = readGithubAccountLinkReturn();
  if (accountLinkReturn) {
    return { kind: "account-link", organizationId: accountLinkReturn.organizationId, consumeBeforePanel: true };
  }
  const installReturn = readGithubInstallAttempt();
  return installReturn
    ? { kind: "install", organizationId: installReturn.organizationId, consumeBeforePanel: true }
    : null;
}

function clearGithubReturnContext(context: GithubReturnContext): void {
  if (context.kind === "account-link") clearGithubAccountLinkReturn();
  else clearGithubInstallAttempt();
}

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
  const { role, organizationId, selectOrganization } = useAuth();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const fromContext = searchParams.get("from") === "context";
  const accountLinkCompleted = searchParams.get("connection") === "github-linked";
  const accountLinkError = searchParams.get("error");
  const githubReturnFlow = searchParams.get("flow");
  const explicitGithubReturn = accountLinkCompleted || accountLinkError !== null;
  const [githubReturnContext] = useState(() =>
    readGithubReturnContext(accountLinkCompleted, accountLinkError, githubReturnFlow),
  );
  // Hold the panel while its original Team is restored or an explicit error
  // marker is consumed. A successful no-code install landing keeps its marker
  // so the restored Team can render the real waiting/recovery state.
  const [returnRestorePending, setReturnRestorePending] = useState(
    () =>
      githubReturnContext !== null &&
      (githubReturnContext.consumeBeforePanel || githubReturnContext.organizationId !== organizationId),
  );
  const returningFromGithub =
    explicitGithubReturn ||
    returnRestorePending ||
    (githubReturnContext?.consumeBeforePanel === false && githubReturnContext.organizationId === organizationId);
  const [returnRestoreError, setReturnRestoreError] = useState(false);
  const restoreAttemptedRef = useRef(false);
  const connectionRef = useRef<HTMLElement>(null);
  const taskRoutingRef = useRef<HTMLElement>(null);

  // React Router updates the fragment but not the app shell's persistent
  // overflow container. Position and focus the requested GitHub section.
  useEffect(() => {
    if (!githubReturnContext || restoreAttemptedRef.current) return;
    restoreAttemptedRef.current = true;
    if (githubReturnContext.organizationId === organizationId) {
      if (githubReturnContext.consumeBeforePanel) clearGithubReturnContext(githubReturnContext);
      setReturnRestorePending(false);
      return;
    }
    void selectOrganization(githubReturnContext.organizationId)
      .then(() => setReturnRestoreError(false))
      .catch(() => setReturnRestoreError(true))
      .finally(() => {
        if (githubReturnContext.consumeBeforePanel) clearGithubReturnContext(githubReturnContext);
        setReturnRestorePending(false);
      });
  }, [githubReturnContext, organizationId, selectOrganization]);

  useEffect(() => {
    if (role === null || returnRestorePending) return;
    const target =
      location.hash === CONNECTION_HASH || returningFromGithub
        ? connectionRef.current
        : location.hash === TASK_ROUTING_HASH
          ? taskRoutingRef.current
          : null;
    if (!target) return;
    target.scrollIntoView({ block: "start" });
    target.focus({ preventScroll: true });
  }, [location.hash, returnRestorePending, returningFromGithub, role]);

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
  if (returnRestorePending) {
    return (
      <div className="text-body" role="status" style={{ padding: "var(--sp-5)", color: "var(--fg-3)" }}>
        Returning to your Team's GitHub settings…
      </div>
    );
  }
  const isAdmin = role === "admin";

  // Page heading + lead are owned by the Settings layout (see settings.tsx).
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-5)", padding: "var(--sp-2) var(--sp-5) var(--sp-7)" }}>
      {fromContext ? <ContextReturn connected={connected} /> : null}
      {returnRestoreError ? (
        <p className="text-body" role="alert" style={{ margin: 0, color: "var(--state-error)" }}>
          We couldn't return to the Team where you started. Select that Team and try again.
        </p>
      ) : null}
      <section
        ref={connectionRef}
        id={CONNECTION_HASH.slice(1)}
        tabIndex={-1}
        aria-label="GitHub connection"
        style={{ scrollMarginTop: "var(--sp-4)" }}
      >
        <Section title="Connection">
          <GithubAppInstallationPanel
            readOnly={!isAdmin}
            initiallyOpen={isAdmin && returningFromGithub && !returnRestoreError}
            accountLinkError={accountLinkError}
          />
        </Section>
      </section>
      <section
        ref={taskRoutingRef}
        id={TASK_ROUTING_HASH.slice(1)}
        tabIndex={-1}
        aria-label="GitHub automatic handling"
        style={{ scrollMarginTop: "var(--sp-4)" }}
      >
        <Section
          title="Automatic handling"
          description="Choose an Agent to handle Issue and pull request activity from connected GitHub repositories."
        >
          <GithubTaskAgentControls />
        </Section>
      </section>
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
