// @vitest-environment happy-dom

import type { ContextTreeIoEvent, ContextTreeSnapshot } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOCK_CONTEXT_SNAPSHOT } from "../context-preview-mock.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const contextApiMocks = vi.hoisted(() => ({
  getContextTreeSnapshot: vi.fn(),
  initializeContextTree: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  value: {
    organizationId: "org-1" as string | null,
    role: "member" as "admin" | "member" | null,
  },
}));

vi.mock("../../api/context-tree.js", () => contextApiMocks);

vi.mock("../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
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

async function renderDom(
  element: ReactElement,
): Promise<{ container: HTMLElement; root: Root; queryClient: QueryClient }> {
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
        <QueryClientProvider client={queryClient}>
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
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
  return { container, root, queryClient };
}

async function rerender(root: Root, queryClient: QueryClient, element: ReactElement): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
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
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function waitForText(container: ParentNode, text: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (container.textContent?.includes(text)) return;
    await flush();
  }
  throw new Error(`Missing text: ${text}\n${container.textContent ?? ""}`);
}

async function waitForCondition(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(message);
}

function snapshot(overrides: Partial<ContextTreeSnapshot> = {}): ContextTreeSnapshot {
  return {
    ...MOCK_CONTEXT_SNAPSHOT,
    syncedAt: "2026-05-28T12:00:00.000Z",
    ...overrides,
    contextStatus: overrides.contextStatus ?? MOCK_CONTEXT_SNAPSHOT.contextStatus,
    summary: overrides.summary ?? MOCK_CONTEXT_SNAPSHOT.summary,
    usage: overrides.usage ?? MOCK_CONTEXT_SNAPSHOT.usage,
    io: overrides.io ?? MOCK_CONTEXT_SNAPSHOT.io,
    nodes: overrides.nodes ?? MOCK_CONTEXT_SNAPSHOT.nodes,
    updates: overrides.updates ?? MOCK_CONTEXT_SNAPSHOT.updates,
    edges: overrides.edges ?? MOCK_CONTEXT_SNAPSHOT.edges,
    changes: overrides.changes ?? MOCK_CONTEXT_SNAPSHOT.changes,
  };
}

function ioEvent(index: number, overrides: Partial<ContextTreeIoEvent> = {}): ContextTreeIoEvent {
  const isWrite = index % 3 === 0;
  return {
    id: `io-event-${index}`,
    agentId: `agent-${index}`,
    agentName: index % 2 === 0 ? `qa.bot-${index}` : `Reviewer ${index}`,
    agentAvatarColorToken: index % 2 === 0 ? "hue-2" : null,
    runtimeProvider: isWrite ? "codex" : "claude-code",
    action: isWrite ? "write" : "read",
    source: isWrite ? "codex_file_change" : "claude_read_tool",
    targetKind: "file",
    targetPath: `domains/topic-${index}/NODE.md`,
    chatId: `chat-${index}`,
    chatTitle: index % 3 === 0 ? "" : `topic-${index}`,
    viewerCanAccess: index % 5 !== 0,
    createdAt: new Date(Date.UTC(2026, 4, 28, 12, 0, 0) - index * 60_000).toISOString(),
    ...overrides,
  };
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(text)) ?? null;
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
  authMock.value = { organizationId: "org-1", role: "member" };
  contextApiMocks.getContextTreeSnapshot.mockReset();
  contextApiMocks.initializeContextTree.mockReset();
  contextApiMocks.initializeContextTree.mockResolvedValue({
    repo: "https://github.com/acme/acme-context-tree.git",
    htmlUrl: "https://github.com/acme/acme-context-tree",
    branch: "main",
    nodePath: "NODE.md",
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("ContextPage DOM behavior", () => {
  it("renders live preview, selects change groups, expands IO, and navigates accessible chats", async () => {
    vi.setSystemTime(new Date("2026-05-28T12:15:00.000Z"));
    const { ContextPage } = await import("../context.js");
    const events = Array.from({ length: 12 }, (_, index) => ioEvent(index + 1));
    const liveSnapshot = snapshot({
      contextStatus: { label: "Needs attention", detail: "Tree sync is stale.", severity: "warning" },
      summary: { addedCount: 2, editedCount: 8, removedCount: 1, changedNodeCount: 3 },
      io: {
        ...MOCK_CONTEXT_SNAPSHOT.io,
        recentEvents: events,
      },
    });

    const { container, root, queryClient } = await renderDom(<ContextPage previewSnapshot={liveSnapshot} />);
    expect(contextApiMocks.getContextTreeSnapshot).not.toHaveBeenCalled();
    // The old centered "Context tree is live" hero is now a LIVE chip in the
    // PageHeader right slot; the warning detail still renders via ContextStatusNote.
    expect(container.textContent).toContain("LIVE");
    expect(container.textContent).toContain("Tree sync is stale.");
    expect(container.textContent).toContain("4 agents");
    expect(container.textContent).toContain("read the tree 18 times");
    expect(container.textContent).toContain("2 agents");
    expect(container.textContent).toContain("wrote 5 times");
    expect(container.textContent).toContain("23total nodes");
    expect(container.textContent).toContain("+6 updates");
    expect(container.textContent).toContain("QB");
    expect(container.textContent).toContain("#chat-3");

    await click(buttonByText(container, "Show all 12"));
    expect(container.textContent).toContain("#hat-12");

    await click(buttonByText(container, "Kael"));
    expect(container.querySelector(".context-network-card.is-live")?.textContent).toContain("Kael");

    await click(buttonByText(container, "#topic-1"));
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe("/?c=chat-1");

    const nextSnapshot = snapshot({
      ...liveSnapshot,
      io: {
        ...liveSnapshot.io,
        recentEvents: [ioEvent(99, { id: "new-event", agentName: "Fresh Agent" }), ...events],
      },
    });
    await rerender(root, queryClient, <ContextPage previewSnapshot={nextSnapshot} />);
    expect(container.querySelector(".context-usage-feed-row.is-fresh")?.textContent).toContain("Fresh Agent");

    await act(async () => root.unmount());
  });

  it("renders empty usage and empty change map states", async () => {
    const { ContextPage } = await import("../context.js");
    const empty = snapshot({
      summary: { addedCount: 0, editedCount: 0, removedCount: 0, changedNodeCount: 0 },
      usage: {
        windowDays: 7,
        agentCount: 0,
        usageCount: 0,
        recentEvents: [],
      },
      io: {
        windowDays: 7,
        summary: {
          read: { agentCount: 0, eventCount: 0, targetCount: 0 },
          write: { agentCount: 0, eventCount: 0, targetCount: 0 },
        },
        agents: [],
        recentEvents: [],
      },
      nodes: MOCK_CONTEXT_SNAPSHOT.nodes.map((node) => ({ ...node, changeType: null, changedAtCommit: null })),
      updates: [],
    });

    const { container, root } = await renderDom(<ContextPage previewSnapshot={empty} />);
    expect(container.textContent).toContain("No context updates in the past 7 days.");
    expect(container.textContent).toContain("No Context Tree reads or writes in the past 7 days.");
    // LIVE reflects the tree's sync liveness, not usage: a synced (active)
    // snapshot shows the header LIVE chip even with zero reads/writes / no
    // events (the streaming IO feed is what hides when empty).
    expect(container.textContent).toContain("LIVE");
    await act(async () => root.unmount());
  });

  it("renders unavailable states with redacted repo details", async () => {
    const { ContextPage } = await import("../context.js");
    const unavailable = snapshot({
      repo: "https://token@example.com/acme/context-tree.git",
      branch: "main",
      snapshotStatus: "unavailable",
      contextStatus: { label: "Sync failed", detail: "Permission denied", severity: "error" },
    });

    const { container, root } = await renderDom(<ContextPage previewSnapshot={unavailable} />);
    expect(container.textContent).toContain("Context Tree sync unavailable");
    expect(container.textContent).toContain("Permission denied");
    expect(container.textContent).toContain("Repo: https://[redacted]@example.com/acme/context-tree.git");
    expect(container.textContent).toContain("Branch: main");
    await act(async () => root.unmount());

    const disconnected = await renderDom(
      <ContextPage
        previewSnapshot={snapshot({
          repo: null,
          branch: null,
          snapshotStatus: "unavailable",
          contextStatus: { label: "Not configured", detail: null, severity: "warning" },
        })}
      />,
    );
    expect(disconnected.container.textContent).toContain("Connect Context Tree");
    expect(disconnected.container.textContent).toContain("Ask an admin to initialize");
    expect(buttonByText(disconnected.container, "Create private GitHub repo")).toBeNull();
    await act(async () => disconnected.root.unmount());
  });

  it("initializes the context tree from the live unavailable admin state", async () => {
    authMock.value = { organizationId: "org-1", role: "admin" };
    const { ContextPage } = await import("../context.js");
    const unavailable = snapshot({
      repo: null,
      branch: null,
      snapshotStatus: "unavailable",
      contextStatus: { label: "Not configured", detail: null, severity: "warning" },
    });
    contextApiMocks.getContextTreeSnapshot.mockResolvedValue(unavailable);
    let resolveInitialize: (value: { repo: string; htmlUrl: string; branch: "main"; nodePath: "NODE.md" }) => void =
      () => undefined;
    contextApiMocks.initializeContextTree.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveInitialize = resolve;
      }),
    );

    const { container, root, queryClient } = await renderDom(<ContextPage />);
    await waitForText(container, "Create private GitHub repo");

    await click(buttonByText(container, "Create private GitHub repo"));
    expect(contextApiMocks.initializeContextTree).toHaveBeenCalledWith("org-1");
    expect(container.textContent).toContain("Creating private GitHub repo");
    expect(container.textContent).toContain("Initializing root NODE.md");
    expect(container.textContent).toContain("Saving team setting");

    await act(async () => {
      resolveInitialize({
        repo: "https://github.com/acme/acme-context-tree.git",
        htmlUrl: "https://github.com/acme/acme-context-tree",
        branch: "main",
        nodePath: "NODE.md",
      });
    });
    await waitForCondition(
      () => contextApiMocks.getContextTreeSnapshot.mock.calls.length > 1,
      "Expected snapshot query to refetch after initialization",
    );
    expect(queryClient.getQueryData(["org-setting", "org-1", "context_tree"])).toEqual({
      repo: "https://github.com/acme/acme-context-tree.git",
      branch: "main",
    });

    await act(async () => root.unmount());
  });

  it("loads and errors through the live query path", async () => {
    const { ContextPage } = await import("../context.js");
    let resolveSnapshot: (value: ContextTreeSnapshot) => void = () => undefined;
    contextApiMocks.getContextTreeSnapshot.mockReturnValue(
      new Promise<ContextTreeSnapshot>((resolve) => {
        resolveSnapshot = resolve;
      }),
    );
    const loading = await renderDom(<ContextPage />);
    expect(loading.container.textContent).toContain("Loading team context...");
    expect(contextApiMocks.getContextTreeSnapshot).toHaveBeenCalledWith("org-1", "7d");
    await act(async () => {
      resolveSnapshot(snapshot());
    });
    await waitForText(loading.container, "LIVE");
    await act(async () => loading.root.unmount());

    contextApiMocks.getContextTreeSnapshot.mockRejectedValueOnce(new Error("Snapshot unavailable"));
    const failed = await renderDom(<ContextPage />);
    await waitForText(failed.container, "Snapshot unavailable");
    await act(async () => failed.root.unmount());

    authMock.value = { organizationId: null, role: null };
    const noOrg = await renderDom(<ContextPage />);
    // No org → query disabled, no snapshot. The page renders only its
    // PageHeader chrome (always present, like every other tab) — no live
    // chip, no IO feed, and no navigation occurs.
    expect(noOrg.container.querySelector('[data-testid="location"]')?.textContent).toBe("/");
    expect(noOrg.container.textContent).not.toContain("LIVE");
    // Assert the IO feed section element is absent (robust to its label text)
    // rather than matching a sublabel string that the data model may rename.
    expect(noOrg.container.querySelector(".context-usage-feed")).toBeNull();
    expect(contextApiMocks.getContextTreeSnapshot).toHaveBeenCalledTimes(2);
    await act(async () => noOrg.root.unmount());
  });
});
