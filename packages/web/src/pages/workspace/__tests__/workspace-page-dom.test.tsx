// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const authMock = vi.hoisted(() => ({
  value: {
    meLoaded: true,
    onboardingStep: "completed" as "connect" | "create_agent" | "completed" | null,
    onboardingDismissedAt: null as string | null,
    onboardingCompletedAt: "2026-05-28T00:00:00.000Z" as string | null,
    currentOrgHasUsableAgent: true,
    currentOrgHasPersonalAgent: true,
  },
}));

const viewportMock = vi.hoisted(() => ({
  value: "xl" as "xl" | "md" | "narrow",
}));

const wsMock = vi.hoisted(() => ({
  useAdminWs: vi.fn(),
}));

vi.mock("../../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

vi.mock("../../../hooks/use-admin-ws.js", () => wsMock);

vi.mock("../../../hooks/use-viewport.js", () => ({
  useWorkspaceViewport: () => viewportMock.value,
}));

vi.mock("../conversations/index.js", () => ({
  DRAFT_CHAT_ID: "draft",
  ConversationList: ({
    selectedChatId,
    onSelectChat,
    onNewChat,
    engagement,
    onEngagementChange,
    unread,
    watching,
    onRailFilterChange,
    origin,
    onOriginChange,
    participants,
    onParticipantsChange,
    onClearFilters,
    group,
    onGroupChange,
    width,
  }: {
    selectedChatId: string | null;
    onSelectChat: (chatId: string) => void;
    onNewChat: () => void;
    engagement: string;
    onEngagementChange: (view: "active" | "archived" | "all") => void;
    unread: boolean;
    watching: boolean;
    onRailFilterChange: (value: "all" | "unread" | "watching") => void;
    origin: string[];
    onOriginChange: (value: string[]) => void;
    participants: string[];
    onParticipantsChange: (value: string[]) => void;
    onClearFilters: () => void;
    group: string;
    onGroupChange: (value: "source" | "recency" | "type" | "none") => void;
    width?: string;
  }) => (
    <aside data-testid="conversation-list" data-width={width ?? ""}>
      <div>
        list:{selectedChatId ?? "none"}:{engagement}:{unread ? "unread" : "read"}:
        {watching ? "watching" : "not-watching"}:{origin.join("|") || "no-origin"}:
        {participants.join("|") || "no-participants"}:{group}
      </div>
      <button type="button" onClick={() => onSelectChat("chat-picked")}>
        Select chat
      </button>
      <button type="button" onClick={onNewChat}>
        New chat
      </button>
      <button type="button" onClick={() => onEngagementChange("archived")}>
        Archived
      </button>
      <button type="button" onClick={() => onRailFilterChange(unread ? "all" : "unread")}>
        Toggle unread
      </button>
      <button type="button" onClick={() => onRailFilterChange(watching ? "all" : "watching")}>
        Toggle watching
      </button>
      <button type="button" onClick={() => onOriginChange(["manual", "github"])}>
        Set origin
      </button>
      <button type="button" onClick={() => onParticipantsChange(["agent-2"])}>
        Set participants
      </button>
      <button type="button" onClick={() => onGroupChange("source")}>
        Set group
      </button>
      <button type="button" onClick={onClearFilters}>
        Clear filters
      </button>
    </aside>
  ),
}));

vi.mock("../center/index.js", () => ({
  CenterPanel: ({
    selectedChatId,
    onSelectChat,
    narrow,
    onShowConversations,
    initialParticipantIds,
  }: {
    selectedChatId: string | null;
    onSelectChat: (chatId: string) => void;
    narrow: boolean;
    onShowConversations: (() => void) | null;
    initialParticipantIds: string[];
  }) => (
    <section data-testid="center-panel">
      center:{selectedChatId ?? "none"}:{narrow ? "narrow" : "wide"}:{initialParticipantIds.join("|") || "no-with"}
      <button type="button" onClick={() => onSelectChat("chat-from-center")}>
        Center select
      </button>
      {onShowConversations ? (
        <button type="button" onClick={onShowConversations}>
          Show conversations
        </button>
      ) : null}
    </section>
  ),
}));

vi.mock("../../../components/doc-preview-drawer.js", () => ({
  DocPreviewDrawer: () => <div data-testid="doc-preview">Doc preview</div>,
}));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderDom(initialEntry: string, element: ReactElement): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/"
            element={
              <>
                <LocationProbe />
                {element}
              </>
            }
          />
          <Route
            path="/quickstart"
            element={
              <>
                <LocationProbe />
                {element}
              </>
            }
          />
          <Route
            path="/onboarding"
            element={
              <>
                <LocationProbe />
                <div>Onboarding route</div>
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
  });
  await flush();
  return { container, root };
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function keyDown(key: string): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  await flush();
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")].find((button) => button.textContent === text) ?? null;
}

function locationParams(container: ParentNode): URLSearchParams {
  const locationText = container.querySelector('[data-testid="location"]')?.textContent ?? "/";
  const query = locationText.includes("?") ? (locationText.split("?")[1] ?? "") : "";
  return new URLSearchParams(query);
}

function lastConversationList(container: ParentNode): HTMLElement | null {
  const lists = [...container.querySelectorAll<HTMLElement>('[data-testid="conversation-list"]')];
  return lists.at(-1) ?? null;
}

beforeEach(() => {
  document.body.innerHTML = "";
  // The group-by preference persists in localStorage; clear it so each
  // test starts from the default rather than a previous test's choice.
  window.localStorage.clear();
  viewportMock.value = "xl";
  authMock.value = {
    meLoaded: true,
    onboardingStep: "completed",
    onboardingDismissedAt: null,
    onboardingCompletedAt: "2026-05-28T00:00:00.000Z",
    currentOrgHasUsableAgent: true,
    currentOrgHasPersonalAgent: true,
  };
  wsMock.useAdminWs.mockReset();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("WorkspacePage DOM behavior", () => {
  it("normalizes legacy URL params and exposes list-driven URL transitions", async () => {
    const { WorkspacePage } = await import("../index.js");
    const { container, root } = await renderDom(
      "/?a=agent-1&c=chat-1&source=manual&docChat=old&docMsg=m&docAttachment=att&docAgent=agent-1&docPath=readme",
      <WorkspacePage />,
    );

    expect(wsMock.useAdminWs).toHaveBeenCalled();
    expect(locationParams(container).get("c")).toBe("chat-1");
    expect(locationParams(container).get("origin")).toBe("manual");
    expect(locationParams(container).get("docChat")).toBe("old");
    // Current attachment-ref params survive the initial normalize.
    expect(locationParams(container).get("docAttachment")).toBe("att");
    expect(locationParams(container).get("docMsg")).toBe("m");
    expect(locationParams(container).get("docAgent")).toBe("agent-1");
    expect(locationParams(container).get("docPath")).toBe("readme");
    expect(container.textContent).toContain("list:chat-1:active");
    expect(container.textContent).toContain("center:chat-1:wide:no-with");

    // R3: switching chat clears the doc-preview overlay — both the current
    // attachment-ref params and the legacy ones — so no stale preview lingers.
    await click(buttonByText(container, "Select chat"));
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe("/?c=chat-picked&origin=manual");
    expect(locationParams(container).get("docAttachment")).toBeNull();
    expect(locationParams(container).get("docMsg")).toBeNull();

    await click(buttonByText(container, "New chat"));
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe("/?c=draft&origin=manual");

    await click(buttonByText(container, "Archived"));
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe(
      "/?origin=manual&engagement=archived",
    );

    await click(buttonByText(container, "Toggle unread"));
    expect(locationParams(container).get("unread")).toBe("1");
    await click(buttonByText(container, "Toggle watching"));
    await click(buttonByText(container, "Set origin"));
    await click(buttonByText(container, "Set participants"));
    await click(buttonByText(container, "Set group"));
    const filtered = locationParams(container);
    expect(filtered.get("engagement")).toBe("archived");
    expect(filtered.get("unread")).toBeNull();
    expect(filtered.get("watching")).toBe("1");
    expect(filtered.get("origin")).toBe("manual,github");
    expect(filtered.get("with")).toBe("agent-2");
    expect(filtered.get("group")).toBe("source");

    await click(buttonByText(container, "Clear filters"));
    // "Clear filters" resets the popover's own dimensions (origin / with /
    // engagement) but LEAVES the header triad (watching) and grouping intact.
    const cleared = locationParams(container);
    expect(cleared.get("watching")).toBe("1");
    expect(cleared.get("group")).toBe("source");
    expect(cleared.has("origin")).toBe(false);
    expect(cleared.has("with")).toBe(false);
    expect(cleared.has("engagement")).toBe(false);
    expect(cleared.has("unread")).toBe(false);

    await act(async () => root.unmount());
  });

  it("renders narrow list as the main view when no chat is selected", async () => {
    const { WorkspacePage } = await import("../index.js");
    viewportMock.value = "narrow";
    const { container, root } = await renderDom(
      "/?origin=unknown,manual&with=agent-1,,agent-1&group=bad",
      <WorkspacePage />,
    );

    const list = container.querySelector<HTMLElement>('[data-testid="conversation-list"]');
    expect(list?.dataset.width).toBe("100%");
    // `group=bad` is unrecognized → falls back to the (empty) stored
    // preference → the `recency` default.
    expect(container.textContent).toContain("list:none:active:read:not-watching:manual:agent-1:recency");
    expect(container.querySelector('[data-testid="center-panel"]')).toBeNull();
    expect(container.querySelector('[data-testid="doc-preview"]')).toBeTruthy();

    await act(async () => root.unmount());
  });

  it("drops the conversation rail on the trial surface and renders the chat full-bleed", async () => {
    const { WorkspaceBody } = await import("../index.js");
    viewportMock.value = "md";
    const { container, root } = await renderDom("/quickstart?c=trial-1", <WorkspaceBody />);

    // No rail (nor its narrow-overlay hamburger) — the trial chat is the whole surface.
    expect(container.querySelector('[data-testid="conversation-list"]')).toBeNull();
    expect(buttonByText(container, "Show conversations")).toBeNull();
    // The chat still renders, selected via ?c=.
    expect(container.querySelector('[data-testid="center-panel"]')).toBeTruthy();
    expect(container.textContent).toContain("center:trial-1:wide");

    await act(async () => root.unmount());
  });

  it("keeps the conversation rail on the normal workspace root", async () => {
    const { WorkspaceBody } = await import("../index.js");
    viewportMock.value = "md";
    const { container, root } = await renderDom("/?c=chat-1", <WorkspaceBody />);
    expect(container.querySelector('[data-testid="conversation-list"]')).toBeTruthy();
    await act(async () => root.unmount());
  });

  it("opens, closes, and auto-dismisses the narrow conversation overlay", async () => {
    const { WorkspacePage } = await import("../index.js");
    viewportMock.value = "narrow";
    const { container, root } = await renderDom("/?c=chat-1&with=agent-1,agent-2", <WorkspacePage />);

    expect(container.querySelector('[data-testid="conversation-list"]')).toBeNull();
    expect(container.textContent).toContain("center:chat-1:narrow:agent-1|agent-2");

    await click(
      buttonByText(container.querySelector('[data-testid="center-panel"]') ?? container, "Show conversations"),
    );
    expect(lastConversationList(container)?.dataset.width).toBe("min(88vw, 20rem)");

    await keyDown("Escape");
    expect(container.querySelector('[data-testid="conversation-list"]')).toBeNull();

    await click(
      buttonByText(container.querySelector('[data-testid="center-panel"]') ?? container, "Show conversations"),
    );
    await click(container.querySelector('button[aria-label="Dismiss"]'));
    expect(container.querySelector('[data-testid="conversation-list"]')).toBeNull();

    await click(
      buttonByText(container.querySelector('[data-testid="center-panel"]') ?? container, "Show conversations"),
    );
    await click(buttonByText(container, "Select chat"));
    expect(container.querySelector('[data-testid="conversation-list"]')).toBeNull();
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe(
      "/?c=chat-picked&with=agent-1%2Cagent-2",
    );

    await click(buttonByText(container, "Center select"));
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe(
      "/?c=chat-from-center&with=agent-1%2Cagent-2",
    );

    await act(async () => root.unmount());
  });

  it("redirects unfinished onboarding users and clears legacy agent-only URLs", async () => {
    const { WorkspacePage } = await import("../index.js");
    authMock.value = {
      meLoaded: true,
      onboardingStep: "connect",
      onboardingDismissedAt: null,
      onboardingCompletedAt: null,
      currentOrgHasUsableAgent: false,
      currentOrgHasPersonalAgent: false,
    };
    const onboarding = await renderDom("/", <WorkspacePage />);
    expect(onboarding.container.textContent).toContain("Onboarding route");
    expect(onboarding.container.querySelector('[data-testid="location"]')?.textContent).toBe("/onboarding");
    await act(async () => onboarding.root.unmount());

    authMock.value = {
      meLoaded: true,
      onboardingStep: "completed",
      onboardingDismissedAt: null,
      onboardingCompletedAt: "2026-05-28T00:00:00.000Z",
      currentOrgHasUsableAgent: true,
      currentOrgHasPersonalAgent: true,
    };
    const legacyAgent = await renderDom("/?a=agent-1", <WorkspacePage />);
    expect(legacyAgent.container.querySelector('[data-testid="location"]')?.textContent).toBe("/");
    await act(async () => legacyAgent.root.unmount());
  });
});
