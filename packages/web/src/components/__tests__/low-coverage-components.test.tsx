// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const disconnectedMocks = vi.hoisted(() => ({
  useDisconnectedComputers: vi.fn(),
}));

const sessionApiMocks = vi.hoisted(() => ({
  listAgentSessions: vi.fn(),
}));

vi.mock("../../hooks/use-disconnected-computers.js", () => disconnectedMocks);
vi.mock("../../api/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/sessions.js")>()),
  listAgentSessions: sessionApiMocks.listAgentSessions,
}));

vi.mock("../../pages/workspace/context/agent-context.js", () => ({
  AgentContext: ({ agentId }: { agentId: string }) => <div>Agent context {agentId}</div>,
}));

function createStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

async function renderDom(element: ReactElement): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
  return { container, root };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error("Expected element to click");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

beforeEach(() => {
  document.body.innerHTML = "";
  const storage = createStorage();
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes("dark"),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
  disconnectedMocks.useDisconnectedComputers.mockReset();
  sessionApiMocks.listAgentSessions.mockReset();
});

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.className = "";
});

describe("low coverage UI components", () => {
  it("renders simple display primitives and AgentChip variants", async () => {
    const { AgentChip } = await import("../agent-chip.js");
    const { HistoryGapBanner } = await import("../history-gap-banner.js");
    const { NewMessagesPill } = await import("../new-messages-pill.js");
    const { UnreadDivider } = await import("../unread-divider.js");
    const { FlatSectionHeader } = await import("../ui/flat-section-header.js");
    const onPillClick = vi.fn();

    const { container, root } = await renderDom(
      <>
        <AgentChip name="nova" displayName="Nova" tone="accent" />
        <AgentChip name="design" displayName="Design" variant="stacked" />
        <AgentChip name={null} displayName={null} emptyLabel="No agent" />
        <HistoryGapBanner />
        <UnreadDivider />
        <div style={{ position: "relative" }}>
          <NewMessagesPill count={1} onClick={onPillClick} />
          <NewMessagesPill count={3} onClick={onPillClick} />
        </div>
        <FlatSectionHeader count={2} right={<button type="button">Action</button>}>
          Section title
        </FlatSectionHeader>
      </>,
    );

    expect(container.textContent).toContain("Nova");
    expect(container.textContent).toContain("@design");
    expect(container.textContent).toContain("No agent");
    expect(container.textContent).toContain("Some older messages may not be loaded");
    expect(container.textContent).toContain("New Messages");
    expect(container.textContent).toContain("1 new message");
    expect(container.textContent).toContain("3 new messages");
    await click(container.querySelector('button[aria-label="1 new message"]'));
    expect(onPillClick).toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("renders DisconnectChip healthy, single, and multi states", async () => {
    const { DisconnectChip } = await import("../disconnect-chip.js");

    disconnectedMocks.useDisconnectedComputers.mockReturnValueOnce({ firstHostname: null, rows: [] });
    const healthy = await renderDom(<DisconnectChip />);
    expect(healthy.container.textContent).toBe("");
    await act(async () => healthy.root.unmount());

    disconnectedMocks.useDisconnectedComputers.mockReturnValueOnce({
      firstHostname: "gandy-macbook",
      rows: [{ clientId: "client-1" }],
    });
    const single = await renderDom(<DisconnectChip />);
    expect(single.container.textContent).toContain("Computer disconnected");
    expect(single.container.textContent).not.toContain("gandy-macbook");
    expect(single.container.querySelector("button")?.getAttribute("aria-label")).toContain("gandy-macbook");
    await act(async () => single.root.unmount());

    disconnectedMocks.useDisconnectedComputers.mockReturnValueOnce({
      firstHostname: "gandy-macbook",
      rows: [{ clientId: "client-1" }, { clientId: "client-2" }],
    });
    const multi = await renderDom(<DisconnectChip />);
    expect(multi.container.textContent).toContain("2 computers disconnected");
    expect(multi.container.querySelector("button")?.getAttribute("title")).toContain("2 computers disconnected");
    await act(async () => multi.root.unmount());
  });

  it("toggles theme and renders toast actions and dismissal", async () => {
    const { ThemeToggle } = await import("../ui/theme-toggle.js");
    const { ToastProvider, useToast } = await import("../ui/toast.js");
    const action = vi.fn();

    function AddToastButton() {
      const toast = useToast();
      return (
        <button
          type="button"
          onClick={() =>
            toast.addToast({
              title: "Saved",
              description: "Changes persisted",
              action: { label: "Undo", onClick: action },
              durationMs: null,
            })
          }
        >
          Add toast
        </button>
      );
    }

    const { container, root } = await renderDom(
      <ToastProvider>
        <ThemeToggle />
        <AddToastButton />
      </ToastProvider>,
    );

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    await click(container.querySelector('button[aria-label="Switch to light theme"]'));
    expect(window.localStorage.getItem("theme")).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    await click([...container.querySelectorAll("button")].find((button) => button.textContent === "Add toast") ?? null);
    expect(container.textContent).toContain("Saved");
    expect(container.textContent).toContain("Changes persisted");
    await click([...container.querySelectorAll("button")].find((button) => button.textContent === "Undo") ?? null);
    expect(action).toHaveBeenCalled();
    expect(container.textContent).not.toContain("Saved");

    await click([...container.querySelectorAll("button")].find((button) => button.textContent === "Add toast") ?? null);
    await click(container.querySelector('button[aria-label="Dismiss"]'));
    expect(container.textContent).not.toContain("Saved");
    await act(async () => root.unmount());
  });

  it("renders ContextPanel session, agent, and empty states", async () => {
    const { ContextPanel } = await import("../../pages/workspace/context/index.js");
    sessionApiMocks.listAgentSessions.mockResolvedValue([
      {
        agentId: "agent-1",
        chatId: "chat-1",
        state: "active",
        runtimeState: "working",
        startedAt: "2026-05-28T12:00:00.000Z",
        lastActivityAt: "2026-05-28T12:05:00.000Z",
        messageCount: 4,
      },
    ]);

    const session = await renderDom(<ContextPanel selectedAgentId="agent-1" selectedChatId="chat-1" />);
    await flush();
    expect(session.container.textContent).toContain("Session");
    expect(session.container.textContent).toContain("chat-1");
    expect(session.container.textContent).toContain("Agent context agent-1");
    await act(async () => session.root.unmount());

    const agent = await renderDom(<ContextPanel selectedAgentId="agent-2" selectedChatId={null} />);
    expect(agent.container.textContent).toContain("Agent context agent-2");
    await act(async () => agent.root.unmount());

    const empty = await renderDom(<ContextPanel selectedAgentId={null} selectedChatId={null} />);
    expect(empty.container.textContent).toBe("");
    await act(async () => empty.root.unmount());
  });
});
