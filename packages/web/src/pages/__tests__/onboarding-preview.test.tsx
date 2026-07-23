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
const SERVER_AUTHORITY = "https://preview.test/api/v1";
const VITE_GENERATION = "0123456789abcdef0123456789abcdef";
const originalFetch = globalThis.fetch;

type PreviewWindow = Window & {
  __ftOrigFetch?: typeof fetch;
};

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
  vi.resetModules();
  authMock.memberships = [];
  document.body.innerHTML = "";
  document.documentElement.className = "";
  window.history.replaceState(null, "", "/preview/onboarding");
  localStorage.clear();
  sessionStorage.clear();
  delete (window as PreviewWindow).__ftOrigFetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "/api/v1/bootstrap/server-authority") {
      return new Response(JSON.stringify({ v: 1, authority: SERVER_AUTHORITY, viteGeneration: VITE_GENERATION }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected preview network request: ${url}`);
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.className = "";
  localStorage.clear();
  delete (window as PreviewWindow).__ftOrigFetch;
  globalThis.fetch = originalFetch;
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
      "Start chat",
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

  it("keeps invitee focused on unique states and moves experiments out of the live flow", async () => {
    const { ONBOARDING_PREVIEW_SCENARIOS } = await import("../onboarding-preview.js");

    const inviteeScenarios = ONBOARDING_PREVIEW_SCENARIOS.filter((scenario) => scenario.role === "invitee");
    expect(inviteeScenarios.some((scenario) => scenario.wizard?.step === "connect-computer")).toBe(false);
    expect(inviteeScenarios.some((scenario) => scenario.wizard?.step === "create-agent")).toBe(false);
    expect(inviteeScenarios.map((scenario) => scenario.id)).toEqual(
      expect.arrayContaining(["inv-link-signedout", "inv-welcome", "inv-ko-ready"]),
    );

    const liveScenarios = ONBOARDING_PREVIEW_SCENARIOS.filter((scenario) => scenario.view !== "experiments");
    expect(liveScenarios.some((scenario) => scenario.mockup)).toBe(false);
    expect(
      ONBOARDING_PREVIEW_SCENARIOS.filter((scenario) => scenario.mockup).every(
        (scenario) => scenario.view === "experiments",
      ),
    ).toBe(true);
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
    expect(window.location.search).toContain("scenario=inv-link-signedout");

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
