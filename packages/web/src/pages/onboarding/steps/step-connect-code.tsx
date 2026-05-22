import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Github } from "lucide-react";
import { useState } from "react";
import { ApiError } from "../../../api/client.js";
import { listGithubRepos } from "../../../api/github.js";
import { getGithubAppInstallation, getGithubAppInstallUrl } from "../../../api/github-app.js";
import { Button } from "../../../components/ui/button.js";
import { COPY } from "../copy.js";
import { FlowNote, RepoPicker, StatusRow } from "../flow-ui.js";
import { useOnboardingFlow } from "../onboarding-flow.js";

/**
 * Admin step: install the GitHub App (the only reliable code-connection
 * entry — `installations/new`, not the sign-in `authorize` URL), then pick
 * the project the AI teammate should help with.
 *
 * Resilient by design — the team's first run can hit any of: App not
 * installed, App not configured on this server, caller isn't an admin,
 * GitHub access lacks project scope, or no repos. Each gets a plain message
 * and a way forward (never a dead end): the user can always continue and
 * connect code later from Settings.
 */
export function StepConnectCode() {
  const { organizationId, goNext, selectedRepoUrls, setSelectedRepoUrls } = useOnboardingFlow();
  const [installError, setInstallError] = useState<"not_configured" | "not_admin" | "generic" | null>(null);
  const [redirecting, setRedirecting] = useState(false);

  const installQuery = useQuery({
    queryKey: ["onboarding", "installation", organizationId],
    queryFn: () => getGithubAppInstallation(organizationId ?? ""),
    enabled: !!organizationId,
    // Poll until an install appears (e.g. the user just came back from
    // GitHub's install dialog); stop once we have one.
    refetchInterval: (query) => (query.state.data ? false : 4000),
  });

  const installed = !!installQuery.data;

  const reposQuery = useQuery({
    queryKey: ["onboarding", "github-repos"],
    queryFn: listGithubRepos,
    enabled: installed,
  });
  const scopeMissing = reposQuery.error instanceof ApiError && reposQuery.error.status === 403;

  const handleConnect = async (): Promise<void> => {
    if (!organizationId) return;
    setInstallError(null);
    setRedirecting(true);
    try {
      const url = await getGithubAppInstallUrl(organizationId, "/onboarding");
      window.location.assign(url);
    } catch (err) {
      setRedirecting(false);
      if (err instanceof ApiError && err.status === 503) setInstallError("not_configured");
      else if (err instanceof ApiError && err.status === 403) setInstallError("not_admin");
      else setInstallError("generic");
    }
  };

  const toggleRepo = (cloneUrl: string): void => {
    setSelectedRepoUrls(
      selectedRepoUrls.includes(cloneUrl)
        ? selectedRepoUrls.filter((u) => u !== cloneUrl)
        : [...selectedRepoUrls, cloneUrl],
    );
  };

  // ── Not connected yet ────────────────────────────────────────────────
  if (!installed) {
    return (
      <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
        <p className="text-label" style={{ margin: 0, color: "var(--fg-4)" }}>
          {COPY.reviewReassurance}
        </p>

        {installError === "not_configured" ? (
          <>
            <FlowNote tone="info">{COPY.connectCode.notConfigured}</FlowNote>
            <ContinueWithout onClick={goNext} />
          </>
        ) : installError === "not_admin" ? (
          <>
            <FlowNote tone="info">{COPY.connectCode.notAdmin}</FlowNote>
            <ContinueWithout onClick={goNext} />
          </>
        ) : (
          <>
            <Button type="button" onClick={() => void handleConnect()} disabled={redirecting || !organizationId}>
              <Github className="h-4 w-4" />
              {COPY.connectCode.cta}
            </Button>
            {installError === "generic" && <FlowNote>{COPY.errors.generic}</FlowNote>}
            <StatusRow state="waiting" label={COPY.connectCode.waiting} />
            <button
              type="button"
              onClick={goNext}
              className="text-label self-start"
              style={{ background: "transparent", border: 0, padding: 0, cursor: "pointer", color: "var(--fg-4)" }}
            >
              {COPY.connectCode.continueWithout}
            </button>
          </>
        )}
      </div>
    );
  }

  // ── Connected — pick the project ─────────────────────────────────────
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
      <StatusRow state="ok" label={COPY.connectCode.connected} />

      <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
        <p className="text-label font-medium" style={{ margin: 0, color: "var(--fg-2)" }}>
          {COPY.connectCode.pickProject}
        </p>

        {scopeMissing ? (
          <FlowNote tone="info">
            <a
              href="/api/v1/auth/github/start?next=/onboarding"
              className="font-medium"
              style={{ color: "var(--accent)" }}
            >
              {COPY.connectCode.reconnect}
            </a>
          </FlowNote>
        ) : reposQuery.isLoading ? (
          <p className="text-label" style={{ margin: 0, color: "var(--fg-4)" }}>
            Loading your projects…
          </p>
        ) : (reposQuery.data?.length ?? 0) === 0 ? (
          <FlowNote tone="info">{COPY.connectCode.noRepos}</FlowNote>
        ) : (
          <RepoPicker repos={reposQuery.data ?? []} selected={selectedRepoUrls} onToggle={toggleRepo} />
        )}
      </div>

      <div className="flex items-center" style={{ gap: "var(--sp-3)" }}>
        <Button
          type="button"
          onClick={goNext}
          disabled={selectedRepoUrls.length === 0 && !scopeMissing && (reposQuery.data?.length ?? 0) > 0}
        >
          <span>{COPY.continue}</span>
          <ArrowRight className="h-4 w-4" />
        </Button>
        {selectedRepoUrls.length === 0 && (
          <button
            type="button"
            onClick={goNext}
            className="text-label"
            style={{ background: "transparent", border: 0, padding: 0, cursor: "pointer", color: "var(--fg-4)" }}
          >
            {COPY.connectCode.continueWithout}
          </button>
        )}
      </div>
    </div>
  );
}

function ContinueWithout({ onClick }: { onClick: () => void }) {
  return (
    <Button type="button" variant="outline" onClick={onClick}>
      <span>{COPY.connectCode.continueWithout}</span>
      <ArrowRight className="h-4 w-4" />
    </Button>
  );
}
