// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "../../auth/auth-context.js";
import { ToastProvider } from "../../components/ui/toast.js";
import { AgentDetailPreviewPage } from "../agent-detail-preview.js";
import { ChatOfflineNoticePreviewPage } from "../chat-offline-notice-preview.js";
import { ChatSummaryPreviewPage } from "../chat-summary-preview.js";
import { CommandPalettePreviewPage } from "../command-palette-preview.js";
import { ContextTreePreviewPage } from "../context-tree-preview.js";
import { ConversationListPreviewPage } from "../conversation-list-preview.js";
import { MobilePreviewPage } from "../mobile-preview.js";
import { MockTeamStepsA, MockTeamStepsB, MockWelcomeCeremonial } from "../onboarding-team-steps-mocks.js";
import { RequestDockPreviewPage } from "../request-dock-preview.js";
import { ResourcesPreviewPage } from "../resources-preview.js";
import { SettingsGithubPreviewPage } from "../settings-github-preview.js";
import { SupportMenuPreviewPage } from "../support-menu-preview.js";
import { TeamSwitcherPreviewPage } from "../team-switcher-preview.js";
import { UserMenuPreviewPage } from "../user-menu-preview.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Rendered = {
  container: HTMLElement;
  queryClient: QueryClient;
  root: Root;
};

type AuthValue = React.ComponentProps<typeof AuthContext.Provider>["value"];

const DEFAULT_AUTH = {
  isAuthenticated: true,
  meLoaded: true,
  user: { id: "preview-human", displayName: "Gandy", username: "gandy2025", avatarUrl: null },
  memberships: [],
  currentMembership: null,
  organizationId: "org-preview",
  memberId: "member-preview",
  role: "admin",
  agentId: "preview-human",
  teamDisplayName: "Preview Team",
  orgHasOtherMembers: true,
  currentOrgHasUsableAgent: true,
  currentOrgHasPersonalAgent: true,
  docsEnabled: true,
  onboardingStep: "completed",
  onboardingDismissedAt: null,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  switchingOrg: null,
  setSwitchingOrg: () => undefined,
  dismissOnboarding: async () => undefined,
  restoreOnboarding: async () => undefined,
  markOnboardingCompleted: async () => undefined,
  login: async () => undefined,
  adoptTokens: async () => undefined,
  selectOrganization: async () => undefined,
  refreshMe: async () => undefined,
  logout: async () => undefined,
} as AuthValue;

const JSON_HEADERS = { "Content-Type": "application/json" };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS });
}

function installBrowserMocks(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: class ResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  });
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: window.ResizeObserver,
  });
  Object.defineProperty(window, "PointerEvent", { configurable: true, value: MouseEvent });
  Object.defineProperty(globalThis, "PointerEvent", { configurable: true, value: MouseEvent });
  HTMLElement.prototype.scrollIntoView = () => undefined;
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0),
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    value: (id: number) => window.clearTimeout(id),
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: window.requestAnimationFrame,
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: window.cancelAnimationFrame });
}

function installFetchMock(): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/me/organizations")) {
      return jsonResponse([{ id: "real-org", name: "real", displayName: "Real Team", role: "member" }]);
    }
    if (url.includes("/settings/context_tree_features")) {
      return jsonResponse({ contextReviewer: { enabled: false, agentUuid: null } });
    }
    if (url.includes("/settings/context_tree")) return jsonResponse({ repo: null, branch: null });
    if (url.includes("/me/chats")) return jsonResponse({ rows: [], nextCursor: null });
    if (url.includes("/agents")) return jsonResponse({ items: [], nextCursor: null });
    if (url.includes("/team-resources") || url.includes("/resources")) return jsonResponse([]);
    return jsonResponse({});
  }) as unknown as typeof fetch;
}

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
    },
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function renderPreview(element: ReactElement, path = "/"): Promise<Rendered> {
  window.history.replaceState(null, "", path);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = createClient();
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <AuthContext.Provider value={DEFAULT_AUTH}>
            <MemoryRouter initialEntries={[path]}>{element}</MemoryRouter>
          </AuthContext.Provider>
        </ToastProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
  return { container, queryClient, root };
}

async function cleanupRendered(rendered: Rendered): Promise<void> {
  await act(async () => rendered.root.unmount());
  rendered.queryClient.clear();
}

function text(container: ParentNode = document.body): string {
  return container.textContent ?? "";
}

function buttonByText(container: ParentNode, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(label));
  if (!button) throw new Error(`Missing button: ${label}`);
  return button;
}

function buttonByLabel(container: ParentNode, label: RegExp): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) => {
    const ariaLabel = candidate.getAttribute("aria-label") ?? "";
    return label.test(ariaLabel);
  });
  if (!button) throw new Error(`Missing labelled button: ${label}`);
  return button;
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function setInputValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  document.body.innerHTML = "";
  document.documentElement.className = "";
  localStorage.clear();
  sessionStorage.clear();
  installBrowserMocks();
  installFetchMock();
});

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.className = "";
  vi.restoreAllMocks();
});

describe("extra preview pages", () => {
  it("renders the seeded agent-detail preview sections", async () => {
    const rendered = await renderPreview(<AgentDetailPreviewPage />);

    expect(text(rendered.container)).toContain("Agent switcher");
    expect(text(rendered.container)).toContain("Environment tab");
    expect(text(rendered.container)).toContain("Tools & skills tab");
    expect(text(rendered.container)).toContain("Instructions tab");
    expect(text(rendered.container)).toContain("Usage tab");
    expect(text(rendered.container)).toContain("Vega");
    expect(text(rendered.container)).toContain("first-tree");
    expect(text(rendered.container)).toContain("release-notes");
    expect(text(rendered.container)).toContain("Team style guide");
    expect(text(rendered.container)).toContain("claude-haiku-4-5");

    await cleanupRendered(rendered);
  });

  it("renders and filters the conversation-list preview", async () => {
    const rendered = await renderPreview(<ConversationListPreviewPage />, "/preview/conversation-list?theme=dark");

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(text(rendered.container)).toContain("Deploy pipeline");
    expect(text(rendered.container)).toContain("Row-state legend");
    expect(text(rendered.container)).toContain("Refactor the auth flow");

    await click(buttonByText(rendered.container, "Watching"));
    expect(text(rendered.container)).toContain("PR repo 688: adapter retries");
    expect(text(rendered.container)).toContain("research squad");

    await click(buttonByText(rendered.container, "Unread"));
    expect(text(rendered.container)).toContain("Q2 hero copy");
    expect(text(rendered.container)).toContain("release-train");

    await click(buttonByText(rendered.container, "toggle"));
    expect(localStorage.getItem("theme")).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    await cleanupRendered(rendered);
  });

  it("renders every settings-github preview state and toggles collapsed details", async () => {
    const rendered = await renderPreview(<SettingsGithubPreviewPage />);

    expect(text(rendered.container)).toContain("Settings");
    expect(text(rendered.container)).toContain("GitHub");
    expect(text(rendered.container)).toContain("Connected");
    expect(text(rendered.container)).toContain("default");
    expect(text(rendered.container)).toContain("details expanded");
    expect(text(rendered.container)).toContain("Suspended upstream");
    expect(text(rendered.container)).toContain("Not installed");
    expect(text(rendered.container)).toContain("waiting");
    expect(text(rendered.container)).toContain("Loading");
    expect(text(rendered.container)).toContain("Waiting for GitHub");

    const detailsButtons = [...rendered.container.querySelectorAll("button")].filter((button) =>
      button.textContent?.includes("Connection details"),
    );
    expect(detailsButtons.length).toBe(3);
    expect(detailsButtons[0]?.getAttribute("aria-expanded")).toBe("false");
    await click(detailsButtons[0] ?? detailsButtons[1] ?? buttonByText(rendered.container, "Connection details"));
    expect(detailsButtons[0]?.getAttribute("aria-expanded")).toBe("true");
    expect(text(rendered.container)).toContain("Installation #131952074");

    await cleanupRendered(rendered);
  });

  it("renders the context-tree preview gallery", async () => {
    const rendered = await renderPreview(<ContextTreePreviewPage />);

    expect(text(rendered.container)).toContain("Repositories");
    expect(text(rendered.container)).toContain("preview");
    expect(text(rendered.container)).toContain("admin, team HAS a tree");
    expect(text(rendered.container)).toContain("member (read-only)");
    expect(text(rendered.container)).toContain("Automatic PR review");
    expect(text(rendered.container)).toContain("build · 2 agents");
    expect(text(rendered.container)).toContain("bound tree recovery");
    expect(text(rendered.container)).toContain("Work on this in chat");

    await cleanupRendered(rendered);
  });

  it("renders the mobile mock preview and opens a chat detail without auth", async () => {
    const rendered = await renderPreview(<MobilePreviewPage />, "/preview/mobile");

    expect(text(rendered.container)).toContain("Now");
    expect(rendered.container.querySelector("h1")?.textContent).toBe("Now");
    expect(text(rendered.container)).not.toContain("2 need attention");
    expect(text(rendered.container)).toContain("Release readiness");
    expect(text(rendered.container)).toContain("Needs your answer");
    expect(text(rendered.container)).not.toContain("Needs attention");
    expect(text(rendered.container)).not.toContain("In progress");
    expect(rendered.container.querySelector("[data-mobile-feed]")).not.toBeNull();
    expect(rendered.container.querySelector('[data-mobile-card="feed"]')).not.toBeNull();
    expect(rendered.container.querySelector("[data-mobile-primary-action]")?.textContent).toContain("Answer");

    await click(buttonByText(rendered.container, "Chat"));
    expect(text(rendered.container)).toContain("Chat");
    expect(text(rendered.container)).toContain("Visual QA");
    expect(rendered.container.querySelector('[data-mobile-card="list"]')).not.toBeNull();

    await click(buttonByLabel(rendered.container, /^Open Release readiness$/));
    expect(text(rendered.container)).toContain("Summary");
    expect(text(rendered.container)).toContain("The mobile shell is ready for review");

    await cleanupRendered(rendered);
  });

  it("renders and reopens the command-palette preview with demo chats and teammates", async () => {
    const rendered = await renderPreview(<CommandPalettePreviewPage />);

    expect(text(document.body)).toContain("Command palette preview");
    expect(text(document.body)).toContain("Recent");
    expect(text(document.body)).toContain("Teammates");
    expect(text(document.body)).toContain("Jump to palette polish");
    expect(text(document.body)).toContain("Archived onboarding audit");
    expect(text(document.body)).toContain("Gandy");
    expect(text(document.body)).toContain("@gandy-coder");

    const input = document.body.querySelector<HTMLInputElement>('input[placeholder^="Jump to chat or teammate"]');
    if (!input) throw new Error("Command palette input missing");
    await setInputValue(input, "CapRover");
    expect(text(document.body)).toContain("CapRover feedback route");

    await cleanupRendered(rendered);
  });

  it("renders resources, chat-summary, offline-notice, and support/user menu previews", async () => {
    const resources = await renderPreview(<ResourcesPreviewPage />);
    expect(text(resources.container)).toContain("Code review checklist");
    expect(text(resources.container)).toContain("frontend design system");
    expect(text(resources.container)).toContain("github");
    await click(buttonByText(resources.container, "theme"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    await cleanupRendered(resources);

    document.documentElement.className = "";
    const summary = await renderPreview(<ChatSummaryPreviewPage />);
    expect(text(summary.container)).toContain("Chat summary");
    expect(text(summary.container)).toContain("states");
    expect(text(summary.container)).toContain("Unread new summary version");
    expect(text(summary.container)).toContain("No description");
    expect(text(summary.container)).toContain("Dark theme");
    await cleanupRendered(summary);

    const offline = await renderPreview(<ChatOfflineNoticePreviewPage />, "/preview/chat-offline-notice?theme=light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(text(offline.container)).toContain("phase 1");
    expect(text(offline.container)).toContain("phase 2");
    expect(text(offline.container)).toContain("gandy-assistant");
    await cleanupRendered(offline);

    const support = await renderPreview(<SupportMenuPreviewPage />);
    await click(buttonByLabel(support.container, /Help and community/));
    expect(text(support.container)).toContain("Need help?");
    expect(text(support.container)).toContain("WeChat group");
    expect(text(support.container)).toContain("Discord");
    await click(buttonByText(support.container, "theme"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    await cleanupRendered(support);

    document.documentElement.className = "";
    const userMenu = await renderPreview(<UserMenuPreviewPage />);
    await click(buttonByLabel(userMenu.container, /User menu, Gandy/));
    expect(text(userMenu.container)).toContain("Gandy");
    expect(text(userMenu.container)).toContain("@gandy2025");
    expect(text(userMenu.container)).toContain("Sign out");
    await click(buttonByText(userMenu.container, "theme"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    await cleanupRendered(userMenu);
  });

  it("renders request-dock modes and exercises reply and skip status branches", async () => {
    const rendered = await renderPreview(<RequestDockPreviewPage />);

    expect(text(rendered.container)).toContain("AskTakeover preview");
    expect(text(rendered.container)).toContain("options");
    expect(text(rendered.container)).toContain("single");
    expect(text(rendered.container)).toContain("multi");
    expect(text(rendered.container)).toContain("free text");
    expect(text(rendered.container)).toContain("cramped height");

    await click(buttonByText(rendered.container, "Ship to 20%"));
    const enabledReply = [...rendered.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Reply" && !button.disabled,
    );
    if (!enabledReply) throw new Error("Enabled Reply button missing");
    await click(enabledReply);
    expect(text(rendered.container)).toContain("Reply");
    expect(text(rendered.container)).toContain("Ship to 20%");

    const firstSkip = [...rendered.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Skip",
    );
    if (!firstSkip) throw new Error("Skip button missing");
    await click(firstSkip);
    expect(text(rendered.container)).toContain("Skipped");
    expect(text(rendered.container)).toContain("resolves the request with a skipped answer");

    await cleanupRendered(rendered);
  });

  it("renders team-switcher preview toggles and path-scoped mock organizations", async () => {
    const rendered = await renderPreview(<TeamSwitcherPreviewPage />, "/preview/team-switcher");

    expect(text(rendered.container)).toContain("First Tree");
    expect(text(rendered.container)).toContain("Single team");
    expect(text(rendered.container)).toContain("Force switch failure");
    expect(text(rendered.container)).toContain("Compact anchor");

    await click(buttonByLabel(rendered.container, /Switch team/));
    expect(text(rendered.container)).toContain("Switch team");
    expect(text(rendered.container)).toContain("Globex");
    expect(text(rendered.container)).toContain("Invite teammates");

    await click(buttonByText(rendered.container, "Single team"));
    await click(buttonByLabel(rendered.container, /Switch team/));
    expect(text(rendered.container)).not.toContain("Globex");
    expect(text(rendered.container)).toContain("Create new team");

    await click(buttonByText(rendered.container, "Compact anchor"));
    await click(buttonByText(rendered.container, "Theme"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    await cleanupRendered(rendered);
  });

  it("renders onboarding team-step mock variants and updates their editable names", async () => {
    const list = await renderPreview(<MockTeamStepsA />);
    expect(text(list.container)).toContain("What's next");
    expect(text(list.container)).toContain("Install First Tree");
    expect(text(list.container)).toContain("Create your first agent");
    const listInput = list.container.querySelector<HTMLInputElement>("#mock-team");
    if (!listInput) throw new Error("MockTeamStepsA input missing");
    await setInputValue(listInput, "Renamed Team");
    expect(listInput.value).toBe("Renamed Team");
    await cleanupRendered(list);

    const oneLine = await renderPreview(<MockTeamStepsB />);
    expect(text(oneLine.container)).toContain("Next:");
    expect(text(oneLine.container)).toContain("Connect to GitHub");
    await cleanupRendered(oneLine);

    const ceremonial = await renderPreview(<MockWelcomeCeremonial />);
    expect(text(ceremonial.container)).toContain("rename it freely");
    const ceremonialInput = ceremonial.container.querySelector<HTMLInputElement>("#mock-cer-team");
    if (!ceremonialInput) throw new Error("MockWelcomeCeremonial input missing");
    await setInputValue(ceremonialInput, "Ceremonial Team");
    expect(ceremonialInput.value).toBe("Ceremonial Team");
    await cleanupRendered(ceremonial);
  });
});
