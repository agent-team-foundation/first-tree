// DEV-only manual-testing preview for the onboarding flow. Renders the real
// step components against a mocked flow context so every state (admin/invitee,
// each step, invitee kickoff sub-states, light/dark) can be exercised by hand
// without a backend or a connected computer. Gated to DEV in app.tsx; stripped
// from production builds. Not part of the real /onboarding route.
//
// Controls drive a full reload (so the fetch stub + React Query re-read the
// chosen scenario cleanly). Open: /preview/onboarding
import { useEffect } from "react";
import type { HubClient } from "../../api/activity.js";
import { OnboardingFlowContext, type OnboardingFlowValue } from "./onboarding-flow.js";
import { OnboardingShell } from "./onboarding-shell.js";
import { ProgressRail } from "./progress-rail.js";
import { StepConnectCode } from "./steps/step-connect-code.js";
import { StepConnectComputer } from "./steps/step-connect-computer.js";
import { StepCreateAgent } from "./steps/step-create-agent.js";
import { StepKickoff } from "./steps/step-kickoff.js";
import { StepTeam } from "./steps/step-team.js";
import { StepWelcome } from "./steps/step-welcome.js";
import { ADMIN_STEPS, INVITEE_STEPS, type OnboardingPath, type StepId } from "./steps.js";

const params = new URLSearchParams(window.location.search);
const PATH = (params.get("path") === "invitee" ? "invitee" : "admin") as OnboardingPath;
const STEPS = PATH === "admin" ? ADMIN_STEPS : INVITEE_STEPS;
const STEP = (STEPS as readonly string[]).includes(params.get("step") ?? "")
  ? (params.get("step") as StepId)
  : STEPS[0];
const SCENARIO = params.get("scenario") ?? "confirm"; // waiting | confirm | picker
const THEME = params.get("theme") === "dark" ? "dark" : "light";

// Stub the invitee-kickoff team-config + repo reads so the sub-states render
// without a backend. (connect-code's installation query fails → "not installed"
// which is itself a valid state to preview.)
const origFetch = window.fetch.bind(window);
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("/settings/context_tree")) {
    return Promise.resolve(json(SCENARIO === "waiting" ? {} : { repo: "https://github.com/acme/team-knowledge" }));
  }
  if (url.includes("/settings/source_repos")) {
    return Promise.resolve(json({ repos: SCENARIO === "confirm" ? [{ url: "https://github.com/acme/web.git" }] : [] }));
  }
  if (url.includes("/me/github/repos")) {
    return Promise.resolve(
      json({
        repos: [
          {
            fullName: "acme/web",
            cloneUrl: "https://github.com/acme/web.git",
            htmlUrl: "https://github.com/acme/web",
            private: true,
            defaultBranch: "main",
            pushedAt: null,
          },
        ],
      }),
    );
  }
  return origFetch(input, init);
};

const noop = () => {};
const anoop = async () => {};

function mockValue(): OnboardingFlowValue {
  const connected = STEP === "create-agent";
  const client: HubClient = {
    id: "c1",
    userId: "u1",
    status: "connected",
    authState: "ok",
    sdkVersion: "1.0.0",
    hostname: "my-mac",
    os: "darwin",
    agentCount: 0,
    connectedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };
  return {
    path: PATH,
    sequence: STEPS,
    activeIndex: Math.max(0, (STEPS as readonly StepId[]).indexOf(STEP)),
    activeStep: STEP,
    goNext: noop,
    goTo: noop,
    organizationId: "org-1",
    memberId: "m-1",
    role: PATH === "admin" ? "admin" : "member",
    username: "you",
    teamDisplayName: "Acme",
    orgHasOtherMembers: PATH === "invitee",
    computer: {
      connectedClient: connected ? client : null,
      capabilitiesLoaded: connected,
      okRuntimes: connected ? ["claude-code"] : [],
      selectedRuntime: connected ? "claude-code" : null,
      setSelectedRuntime: noop,
      cliCommand: "npm install -g first-tree\nfirst-tree login a1b2c3d4e5f6g7h8i9",
      tokenError: null,
    },
    agentDisplayName: "you's assistant",
    setAgentDisplayName: noop,
    visibility: "organization",
    setVisibility: noop,
    agentPhase: "idle",
    agentError: null,
    createAgent: anoop,
    retryAgent: anoop,
    createdAgentUuid: null,
    hasAgent: STEP === "kickoff",
    selectedRepoUrls: ["https://github.com/acme/web.git"],
    setSelectedRepoUrls: noop,
    treeMode: "new",
    setTreeMode: noop,
    treeUrl: "",
    setTreeUrl: noop,
    completeAndEnterChat: anoop,
    finishLater: anoop,
  };
}

function reloadWith(updates: Record<string, string>): void {
  const next = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(updates)) next.set(k, v);
  window.location.search = next.toString();
}

const selectStyle = {
  padding: "var(--sp-1) var(--sp-2)",
  background: "var(--bg)",
  border: "var(--hairline) solid var(--border)",
  borderRadius: "var(--radius-input)",
  color: "var(--fg)",
};

function ControlBar() {
  return (
    <div
      className="flex items-center"
      style={{
        gap: "var(--sp-3)",
        padding: "var(--sp-2) var(--sp-4)",
        borderBottom: "var(--hairline) solid var(--border)",
        background: "var(--bg-raised)",
        flexWrap: "wrap",
      }}
    >
      <span className="text-label font-semibold" style={{ color: "var(--fg-2)" }}>
        Onboarding preview
      </span>
      <label className="text-label" style={{ color: "var(--fg-3)" }}>
        Path{" "}
        <select
          value={PATH}
          onChange={(e) => reloadWith({ path: e.target.value, step: "" })}
          className="text-label"
          style={selectStyle}
        >
          <option value="admin">admin</option>
          <option value="invitee">invitee</option>
        </select>
      </label>
      <label className="text-label" style={{ color: "var(--fg-3)" }}>
        Step{" "}
        <select
          value={STEP}
          onChange={(e) => reloadWith({ step: e.target.value })}
          className="text-label"
          style={selectStyle}
        >
          {STEPS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      {PATH === "invitee" && STEP === "kickoff" && (
        <label className="text-label" style={{ color: "var(--fg-3)" }}>
          Scenario{" "}
          <select
            value={SCENARIO}
            onChange={(e) => reloadWith({ scenario: e.target.value })}
            className="text-label"
            style={selectStyle}
          >
            <option value="waiting">waiting</option>
            <option value="confirm">confirm</option>
            <option value="picker">picker</option>
          </select>
        </label>
      )}
      <button
        type="button"
        onClick={() => reloadWith({ theme: THEME === "dark" ? "light" : "dark" })}
        className="text-label"
        style={{ ...selectStyle, cursor: "pointer" }}
      >
        Theme: {THEME}
      </button>
    </div>
  );
}

function Body() {
  switch (STEP) {
    case "team":
      return <StepTeam />;
    case "welcome":
      return <StepWelcome />;
    case "connect-code":
      return <StepConnectCode />;
    case "connect-computer":
      return <StepConnectComputer />;
    case "create-agent":
      return <StepCreateAgent />;
    case "kickoff":
      return <StepKickoff />;
    default:
      return null;
  }
}

export function OnboardingPreviewPage() {
  useEffect(() => {
    const root = document.documentElement;
    if (THEME === "dark") root.classList.add("dark");
    return () => {
      root.classList.remove("dark");
    };
  }, []);

  return (
    <OnboardingFlowContext.Provider value={mockValue()}>
      <ControlBar />
      <OnboardingShell rail={<ProgressRail />}>
        <Body />
      </OnboardingShell>
    </OnboardingFlowContext.Provider>
  );
}
