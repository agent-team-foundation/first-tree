// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const PROD_BOOTSTRAP_COMMAND =
  "curl -fsSL https://download.first-tree.ai/releases/prod/install.sh | sh\n" +
  "~/.local/bin/first-tree login ft_3aK9d2hQ7s_pVx1n8Wc4Lr6";

const authMock = vi.hoisted(() => ({ memberships: [] as unknown[] }));

vi.mock("../../auth/auth-context.js", () => ({
  useAuth: () => ({ logout: () => undefined, memberships: authMock.memberships }),
}));

vi.mock("../../components/ui/toast.js", () => ({
  useToast: () => ({ addToast: () => undefined }),
}));

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderDom(element: ReactElement): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  await flush();
  return { container, root };
}

async function clickByText(container: ParentNode, text: string): Promise<void> {
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === text);
  if (!button) throw new Error(`Missing button: ${text}`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function waitForText(container: ParentNode, text: string): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    if (container.textContent?.includes(text)) return;
    await flush();
  }
  throw new Error(`Missing text: ${text}\nRendered: ${container.textContent?.slice(0, 1200) ?? ""}`);
}

beforeEach(() => {
  authMock.memberships = [];
  document.body.innerHTML = "";
  document.documentElement.className = "";
  window.history.replaceState(null, "", "/preview/onboarding");
  localStorage.clear();
  sessionStorage.clear();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.className = "";
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("onboarding preview review surface", () => {
  it("keeps admin flow aligned to the lightweight onboarding path", async () => {
    const { ONBOARDING_PREVIEW_SCENARIOS } = await import("../onboarding-preview.js");

    const adminFlow = ONBOARDING_PREVIEW_SCENARIOS.filter(
      (scenario) => scenario.role === "admin" && scenario.view === "flow",
    );

    expect(adminFlow.map((scenario) => scenario.id)).toEqual([
      "admin-team",
      "admin-cc-waiting",
      "admin-ca-form",
      "admin-ko-new",
    ]);
    expect(adminFlow.map((scenario) => scenario.label)).toEqual([
      "Create team",
      "Connect computer",
      "Create agent",
      "Meet your agent",
    ]);
    expect(adminFlow.some((scenario) => scenario.wizard?.step === "connect-code")).toBe(false);
  });

  it("keeps preview labels aligned to product step names", async () => {
    const { ONBOARDING_PREVIEW_SCENARIOS } = await import("../onboarding-preview.js");

    const previewText = ONBOARDING_PREVIEW_SCENARIOS.flatMap((scenario) => [scenario.label, scenario.group]).join("\n");

    expect(previewText).not.toMatch(/\bKickoff\b/);
    expect(previewText).not.toContain("Install First Tree");
    expect(previewText).not.toContain("No Context Tree finale");
  });

  it("shows the complete member branch map in the flow gallery", async () => {
    const { ONBOARDING_PREVIEW_SCENARIOS } = await import("../onboarding-preview.js");
    const inviteeFlow = ONBOARDING_PREVIEW_SCENARIOS.filter(
      (scenario) => scenario.role === "invitee" && scenario.view === "flow",
    );

    expect(inviteeFlow.map((scenario) => scenario.id)).toEqual([
      "inv-fork-choose",
      "inv-cc-waiting",
      "inv-ca-form",
      "inv-ko-ready",
      "inv-workspace-personal-chat",
      "inv-workspace-team-pick",
      "inv-workspace-team-chat",
      "inv-progressive-no-team-agent",
    ]);
    expect(inviteeFlow.filter((scenario) => scenario.group === "Recommended onboarding")).toHaveLength(5);
    expect(inviteeFlow.filter((scenario) => scenario.group === "Continue without · Team agent available")).toHaveLength(
      2,
    );
    expect(inviteeFlow.filter((scenario) => scenario.group === "Continue without · no Team agent")).toHaveLength(1);
  });

  it("keeps the member entry single-path and reveals alternatives only after continue without", async () => {
    authMock.memberships = [{}];
    window.history.replaceState(null, "", "/preview/onboarding?role=invitee&view=flow&scenario=inv-fork-choose");

    const { OnboardingPreviewPage } = await import("../onboarding-preview.js");
    const entry = await renderDom(
      <MemoryRouter>
        <OnboardingPreviewPage />
      </MemoryRouter>,
    );
    const entryPanel = entry.container.querySelector("#onboarding-preview-root > main");
    if (!entryPanel) throw new Error("Missing active preview panel");

    expect(entryPanel.textContent).toContain("You've joined Gandy's team");
    expect(entryPanel.textContent).toContain("Set up your First Tree agent");
    expect(entryPanel.textContent).toContain("Set up my agent");
    expect(entryPanel.textContent).toContain("Continue without my own agent");
    expect(entryPanel.textContent).not.toContain("What happens next");
    expect(entryPanel.textContent).not.toContain("You can set up or change your agent later in Settings.");
    expect(entryPanel.textContent).not.toContain("Start with a Team agent");
    expect(entryPanel.textContent).not.toContain("Claude Code or Codex");
    await act(async () => entry.root.unmount());

    window.history.replaceState(
      null,
      "",
      "/preview/onboarding?role=invitee&view=flow&scenario=inv-workspace-team-pick",
    );
    const teamPicker = await renderDom(
      <MemoryRouter>
        <OnboardingPreviewPage />
      </MemoryRouter>,
    );

    expect(teamPicker.container.textContent).toContain("Pick a team agent");
    expect(teamPicker.container.textContent).toContain("Dev Assistant");
    expect(teamPicker.container.textContent).toContain("Run by Zhang Wei");
    expect(teamPicker.container.textContent).toContain("Uses Zhang Wei's connected computer and coding plan");
    expect(teamPicker.container.textContent).toContain("Use the Context Tree in Claude Code or Codex");
    expect(teamPicker.container.textContent).toContain("Add this team's Context Tree to one local project");
    expect(teamPicker.container.textContent).not.toContain("Copy setup prompt");
    expect(
      Array.from(teamPicker.container.querySelectorAll("button")).some((button) =>
        button.textContent?.includes("Use the Context Tree in Claude Code or Codex"),
      ),
    ).toBe(true);
    await act(async () => teamPicker.root.unmount());
  });

  it("adapts continue without when the Team has no available agent", async () => {
    authMock.memberships = [{}];
    window.history.replaceState(
      null,
      "",
      "/preview/onboarding?role=invitee&view=flow&scenario=inv-progressive-no-team-agent",
    );

    const { OnboardingPreviewPage } = await import("../onboarding-preview.js");
    const { container, root } = await renderDom(
      <MemoryRouter>
        <OnboardingPreviewPage />
      </MemoryRouter>,
    );

    expect(container.textContent).toContain("Set up your First Tree agent");
    expect(container.textContent).toContain("Use the Context Tree in Claude Code or Codex");
    expect(container.textContent).toContain("Back");
    expect(container.textContent).toContain("Continue without your own agent");
    expect(container.textContent).not.toContain("Pick a team agent");
    expect(container.textContent).not.toContain("Continue without my own agent");
    expect(container.textContent).toContain("No Team agent is available right now");
    expect(container.textContent).not.toContain("Copy setup prompt");
    expect(
      Array.from(container.querySelectorAll("button")).some((button) =>
        button.textContent?.includes("Use the Context Tree in Claude Code or Codex"),
      ),
    ).toBe(true);

    await act(async () => root.unmount());
  });

  it("renders the full production shell bootstrap without the removed Node.js recovery state", async () => {
    authMock.memberships = [{}];
    window.history.replaceState(null, "", "/preview/onboarding?role=admin&view=flow");

    const { ONBOARDING_PREVIEW_SCENARIOS, OnboardingPreviewPage } = await import("../onboarding-preview.js");
    const scenarioCatalog = ONBOARDING_PREVIEW_SCENARIOS.flatMap((scenario) => [
      scenario.id,
      scenario.label,
      scenario.group,
    ]).join("\n");
    expect(scenarioCatalog).not.toContain("admin-cc-stuck");
    expect(scenarioCatalog).not.toContain("Node.js");

    const { container, root } = await renderDom(
      <MemoryRouter>
        <OnboardingPreviewPage />
      </MemoryRouter>,
    );
    await clickByText(container, "Connect computer");
    expect(window.location.search).toContain("scenario=admin-cc-waiting");
    await waitForText(container, "https://download.first-tree.ai/releases/prod/install.sh");
    const commandBox = [...document.body.querySelectorAll<HTMLElement>("[title]")].find(
      (element) => element.title === PROD_BOOTSTRAP_COMMAND,
    );

    expect(commandBox?.title).toBe(PROD_BOOTSTRAP_COMMAND);
    const commandLines = commandBox ? [...commandBox.querySelectorAll("span")].map((line) => line.textContent) : [];
    expect(commandLines).toEqual(PROD_BOOTSTRAP_COMMAND.split("\n"));
    expect(container.textContent).not.toContain("admin-cc-stuck");
    expect(container.textContent).not.toContain("Node.js");
    expect(container.textContent).not.toContain("Install Node.js");

    await act(async () => root.unmount());
  });

  it("covers the complete invitee path and moves experiments out of the live flow", async () => {
    const { ONBOARDING_PREVIEW_SCENARIOS } = await import("../onboarding-preview.js");

    const inviteeScenarios = ONBOARDING_PREVIEW_SCENARIOS.filter((scenario) => scenario.role === "invitee");
    expect(inviteeScenarios.some((scenario) => scenario.wizard?.step === "connect-computer")).toBe(true);
    expect(inviteeScenarios.some((scenario) => scenario.wizard?.step === "create-agent")).toBe(true);
    expect(inviteeScenarios.map((scenario) => scenario.id)).toEqual(
      expect.arrayContaining(["inv-link-signedout", "inv-fork-choose", "inv-ko-ready"]),
    );

    const liveScenarios = ONBOARDING_PREVIEW_SCENARIOS.filter((scenario) => scenario.view !== "experiments");
    expect(liveScenarios.some((scenario) => scenario.mockup)).toBe(false);
    expect(
      ONBOARDING_PREVIEW_SCENARIOS.filter((scenario) => scenario.mockup).every(
        (scenario) => scenario.view === "experiments",
      ),
    ).toBe(true);
  });

  it("keeps only the progressive concept experiments for both roles", async () => {
    const { ONBOARDING_PREVIEW_SCENARIOS } = await import("../onboarding-preview.js");

    const experimentIds = (role: "admin" | "invitee") =>
      ONBOARDING_PREVIEW_SCENARIOS.filter((scenario) => scenario.role === role && scenario.view === "experiments").map(
        (scenario) => scenario.id,
      );

    expect(experimentIds("admin")).toEqual([
      "admin-concept-connect-computer",
      "admin-concept-create-agent",
      "admin-concept-start-chat",
    ]);
    expect(experimentIds("invitee")).toEqual([
      "inv-concept-connect-computer",
      "inv-concept-create-agent",
      "inv-concept-start-chat",
    ]);

    const catalog = ONBOARDING_PREVIEW_SCENARIOS.flatMap((scenario) => [scenario.id, scenario.group]).join("\n");
    expect(catalog).not.toContain("Create-team experiments");
    expect(catalog).not.toContain("admin-team-steps");
    expect(catalog).not.toContain("admin-welcome-ceremonial");
  });

  it("uses the accepted concept copy in both focused previews and the live flow", async () => {
    const { OnboardingPreviewPage } = await import("../onboarding-preview.js");

    window.history.replaceState(
      null,
      "",
      "/preview/onboarding?role=admin&view=experiments&scenario=admin-concept-connect-computer",
    );
    const connect = await renderDom(
      <MemoryRouter>
        <OnboardingPreviewPage />
      </MemoryRouter>,
    );
    expect(connect.container.textContent).toContain(
      "Install the First Tree app to connect this computer and detect what your agents can run.",
    );
    expect(connect.container.textContent).not.toContain("does not run a task or open any project files");
    expect(connect.container.textContent).toContain("Run this command in your terminal");
    expect(connect.container.textContent).not.toContain("Or paste this into your AI coding tool");
    expect(connect.container.textContent).not.toContain("Or paste this to your Claude Code, Codex, or Cursor agent");
    await act(async () => connect.root.unmount());

    window.history.replaceState(
      null,
      "",
      "/preview/onboarding?role=admin&view=experiments&scenario=admin-concept-create-agent",
    );
    const create = await renderDom(
      <MemoryRouter>
        <OnboardingPreviewPage />
      </MemoryRouter>,
    );
    expect(create.container.textContent).toContain(
      "Build your own group of agents for different work in this team. Let’s create your first one.",
    );
    expect(create.container.textContent).toContain("This agent will run");
    expect(create.container.textContent).not.toContain("Each agent can use a different tool.");
    expect(create.container.textContent).toContain("Claude Code");
    expect(create.container.textContent).toContain("Codex");
    expect(create.container.textContent).toContain("OpenCode");
    expect(create.container.textContent).toContain("Pi");
    expect(
      create.container
        .querySelector<HTMLInputElement>('input[name="onboarding-coding-agent"]:checked')
        ?.closest("label")?.textContent,
    ).toContain("Codex");
    const createText = create.container.textContent ?? "";
    expect(createText.indexOf("Name your agent")).toBeLessThan(createText.indexOf("This agent will run"));
    expect(createText.indexOf("This agent will run")).toBeLessThan(createText.indexOf("Who can use it?"));
    expect(createText.indexOf("Codex")).toBeLessThan(createText.indexOf("Claude Code"));
    expect(createText.indexOf("Claude Code")).toBeLessThan(createText.indexOf("OpenCode"));
    expect(createText.indexOf("OpenCode")).toBeLessThan(createText.indexOf("Pi"));
    await act(async () => create.root.unmount());

    window.history.replaceState(
      null,
      "",
      "/preview/onboarding?role=admin&view=experiments&scenario=admin-concept-start-chat",
    );
    const start = await renderDom(
      <MemoryRouter>
        <OnboardingPreviewPage />
      </MemoryRouter>,
    );
    expect(start.container.textContent).toContain("YOUR FIRST TREE AGENT");
    expect(start.container.textContent).toContain("Meet Gandy's assistant");
    expect(start.container.textContent).toContain(
      "Gandy's assistant is ready to explore First Tree with you. Bring a question, a project, or a task you want to move forward.",
    );
    expect(start.container.textContent).toContain("Meet your agent");
    expect(start.container.textContent).toContain("You’ll open your first Chat and can start typing right away.");
    expect(start.container.textContent).not.toContain("Stay connected");
    expect(start.container.textContent).not.toContain("WeChat group");
    expect(start.container.textContent).not.toContain("Discord");
    await act(async () => start.root.unmount());

    window.history.replaceState(null, "", "/preview/onboarding?role=admin&view=states&scenario=admin-ko-noproject");
    const liveStart = await renderDom(
      <MemoryRouter>
        <OnboardingPreviewPage />
      </MemoryRouter>,
    );
    expect(liveStart.container.textContent).toContain("Meet Gandy's assistant");
    expect(liveStart.container.textContent).toContain(
      "Gandy's assistant is ready to explore First Tree with you. Bring a question, a project, or a task you want to move forward.",
    );
    expect(liveStart.container.textContent).toContain("Meet your agent");
    expect(liveStart.container.textContent).not.toContain("Stay connected");
    await act(async () => liveStart.root.unmount());

    window.history.replaceState(null, "", "/preview/onboarding?role=admin&view=flow&scenario=admin-ca-form");
    const live = await renderDom(
      <MemoryRouter>
        <OnboardingPreviewPage />
      </MemoryRouter>,
    );
    expect(live.container.textContent).toContain(
      "Build your own group of agents for different work in this team. Let’s create your first one.",
    );
    expect(live.container.textContent).toContain("This agent will run");
    const liveText = live.container.textContent ?? "";
    expect(liveText.indexOf("Name your agent")).toBeLessThan(liveText.indexOf("This agent will run"));
    expect(liveText.indexOf("This agent will run")).toBeLessThan(liveText.indexOf("Who can use it?"));
    await act(async () => live.root.unmount());
  });

  it("does not repeat the BYO choice after the member selected a First Tree agent", async () => {
    authMock.memberships = [{}];
    window.history.replaceState(null, "", "/preview/onboarding?role=invitee&view=flow&scenario=inv-ko-ready");

    const { OnboardingPreviewPage } = await import("../onboarding-preview.js");
    const { container, root } = await renderDom(
      <MemoryRouter>
        <OnboardingPreviewPage />
      </MemoryRouter>,
    );

    await waitForText(container, "Meet your agent");
    expect(container.textContent).not.toContain("Use Team Context in your coding agent");
    expect(container.textContent).not.toContain("Copy setup prompt");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("keeps the Team-agent destination honest about resumable personal setup", async () => {
    authMock.memberships = [{}];
    window.history.replaceState(
      null,
      "",
      "/preview/onboarding?role=invitee&view=flow&scenario=inv-workspace-team-chat",
    );

    const { OnboardingPreviewPage } = await import("../onboarding-preview.js");
    const { container, root } = await renderDom(
      <MemoryRouter>
        <OnboardingPreviewPage />
      </MemoryRouter>,
    );

    expect(container.textContent).toContain("Personal agent setup remains available");
    expect(container.textContent).toContain("Get to know First Tree");
    expect(container.textContent).toContain("Start with Dev Assistant");
    expect(container.textContent).not.toContain("welcome aboard");
    expect(container.textContent).not.toContain("Reading the team's shared context");
    expect(container.textContent).not.toContain("Onboarding complete");

    await act(async () => root.unmount());
  });

  it("keeps GitHub preview states visually distinct", async () => {
    const { ONBOARDING_PREVIEW_SCENARIOS } = await import("../onboarding-preview.js");

    const adminGithubStateIds = ONBOARDING_PREVIEW_SCENARIOS.filter(
      (scenario) => scenario.role === "admin" && scenario.group === "GitHub access states",
    ).map((scenario) => scenario.id);

    expect(adminGithubStateIds).toEqual([
      "admin-code-notinstalled",
      "admin-code-err-cantconnect",
      "admin-code-err-generic",
      "admin-code-waiting",
      "admin-code-loading",
      "admin-code-norepos",
      "admin-code-loadfailed",
      "admin-code-repos",
      "admin-code-repos-user",
    ]);
    expect(
      ONBOARDING_PREVIEW_SCENARIOS.some(
        (scenario) => /Need help|stuck|403|503/.test(scenario.label) && scenario.group === "GitHub access states",
      ),
    ).toBe(false);
  });

  it("renders GitHub access states outside the onboarding setup step shell", async () => {
    window.history.replaceState(
      null,
      "",
      "/preview/onboarding?role=admin&view=states&scenario=admin-code-notinstalled",
    );

    const { OnboardingPreviewPage } = await import("../onboarding-preview.js");
    const { container, root } = await renderDom(
      <MemoryRouter>
        <OnboardingPreviewPage />
      </MemoryRouter>,
    );

    expect(container.textContent).toContain("GitHub access states");
    expect(container.textContent).toContain("Connect GitHub when a task needs it");
    expect(container.textContent).toContain("not a required onboarding step");
    expect(container.textContent).toContain("Install First Tree on GitHub");
    expect(container.textContent).not.toContain("Step 1 of 3");
    expect(container.textContent).not.toContain("Create a First Tree team");

    await act(async () => root.unmount());
  });

  it("uses URL params for shareable role, view, and scenario selection", async () => {
    window.history.replaceState(null, "", "/preview/onboarding?role=invitee&view=states&scenario=inv-ko-not-ready");

    const { OnboardingPreviewPage } = await import("../onboarding-preview.js");
    const { container, root } = await renderDom(
      <MemoryRouter>
        <OnboardingPreviewPage />
      </MemoryRouter>,
    );

    expect(container.textContent).toContain("State inventory");
    expect(container.textContent).toContain("Team not ready");
    expect(container.textContent).not.toContain("Waiting for computer");
    expect(container.textContent).not.toContain("Form (idle)");

    await clickByText(container, "Flow");
    expect(window.location.search).toContain("role=invitee");
    expect(window.location.search).toContain("view=flow");
    expect(window.location.search).toContain("scenario=inv-fork-choose");

    await act(async () => root.unmount());
  });

  it("renders one self-contained BYO prompt without a First Tree agent step", async () => {
    authMock.memberships = [{}];
    window.history.replaceState(null, "", "/preview/onboarding?role=invitee&view=states&scenario=inv-byo-setup");

    const { OnboardingPreviewPage } = await import("../onboarding-preview.js");
    const { container, root } = await renderDom(
      <MemoryRouter>
        <OnboardingPreviewPage />
      </MemoryRouter>,
    );

    await waitForText(container, "first-tree login ft_");
    await waitForText(container, "context enable --provider 'claude-code' --team 'org-acme'");
    expect(container.textContent).toContain("Setup prompt");
    expect(container.textContent).toContain("Claude Code or Codex for Gandy's team");
    expect(container.textContent).toContain("Connects this computer if needed");
    expect(container.textContent).toContain("enables Team Context for this local project");
    expect(container.textContent).toContain("zero, one, or many source repositories");
    expect(
      [...container.querySelectorAll("button")].filter((button) => button.textContent === "Copy setup prompt"),
    ).toHaveLength(1);
    expect(container.textContent).toContain("does not create a First Tree agent");
    expect(container.textContent).not.toContain("Name your agent");

    await act(async () => root.unmount());
  });

  it("keeps the complete BYO setup inside the selected coding agent", async () => {
    authMock.memberships = [{}];
    window.history.replaceState(null, "", "/preview/onboarding?role=invitee&view=states&scenario=inv-byo-setup");

    const { OnboardingPreviewPage } = await import("../onboarding-preview.js");
    const { container, root } = await renderDom(
      <MemoryRouter>
        <OnboardingPreviewPage />
      </MemoryRouter>,
    );

    await waitForText(container, "Claude Code or Codex for Gandy's team");
    await waitForText(container, "View full prompt");
    expect(container.textContent).not.toContain("Run this command in your terminal");
    expect(container.textContent).not.toContain("Run manually in Terminal");
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.textContent).toContain("View full prompt");

    await act(async () => root.unmount());
  });

  it("renders GitHub repo loading outcomes from the active preview network profile", async () => {
    const { OnboardingPreviewPage } = await import("../onboarding-preview.js");

    window.history.replaceState(null, "", "/preview/onboarding?role=admin&view=states&scenario=admin-code-loadfailed");
    const loadFailed = await renderDom(
      <MemoryRouter>
        <OnboardingPreviewPage />
      </MemoryRouter>,
    );
    await waitForText(loadFailed.container, "Couldn't load your team's repos");
    await act(async () => loadFailed.root.unmount());

    window.history.replaceState(null, "", "/preview/onboarding?role=admin&view=states&scenario=admin-code-norepos");
    const noRepos = await renderDom(
      <MemoryRouter>
        <OnboardingPreviewPage />
      </MemoryRouter>,
    );
    await waitForText(noRepos.container, "No repos are shared with First Tree yet");
    await waitForText(noRepos.container, "0 repositories available");
    await act(async () => noRepos.root.unmount());

    window.history.replaceState(null, "", "/preview/onboarding?role=admin&view=states&scenario=admin-code-repos-user");
    const repos = await renderDom(
      <MemoryRouter>
        <OnboardingPreviewPage />
      </MemoryRouter>,
    );
    await waitForText(repos.container, "Connected to");
    await waitForText(repos.container, "gandy");
    await waitForText(repos.container, "User");
    await waitForText(repos.container, "3 repositories available");

    await act(async () => repos.root.unmount());
  });

  it("wires the preview sidebar theme and role controls", async () => {
    window.history.replaceState(null, "", "/preview/onboarding?role=admin&view=states&scenario=admin-code-repos-user");

    const { OnboardingPreviewPage } = await import("../onboarding-preview.js");
    const { container, root } = await renderDom(
      <MemoryRouter>
        <OnboardingPreviewPage />
      </MemoryRouter>,
    );

    await clickByText(container, "dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("theme")).toBe("dark");

    await clickByText(container, "invitee");
    expect(window.location.search).toContain("role=invitee");

    await act(async () => root.unmount());
  });

  it("surfaces preview install-url failures through the real install button", async () => {
    window.history.replaceState(
      null,
      "",
      "/preview/onboarding?role=admin&view=states&scenario=admin-code-err-cantconnect",
    );
    vi.spyOn(window, "open").mockReturnValue(null);

    const { OnboardingPreviewPage } = await import("../onboarding-preview.js");
    const { container, root } = await renderDom(
      <MemoryRouter>
        <OnboardingPreviewPage />
      </MemoryRouter>,
    );

    await clickByText(container, "Install First Tree on GitHub");

    await waitForText(container, "Couldn't connect a repo here right now");
    expect(sessionStorage.getItem("onboarding:connect-code:install-attempt")).toBeNull();

    await act(async () => root.unmount());
  });
});
