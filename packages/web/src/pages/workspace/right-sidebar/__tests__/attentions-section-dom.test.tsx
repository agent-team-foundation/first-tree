// @vitest-environment happy-dom

import type { Attention } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attentionsInChatQueryKey } from "../../../../api/attention.js";
import { AttentionsSection } from "../attentions-section.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const attentionMocks = vi.hoisted(() => ({
  listAttentionsInChat: vi.fn(),
}));

vi.mock("../../../../api/attention.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../api/attention.js")>()),
  listAttentionsInChat: attentionMocks.listAttentionsInChat,
}));
vi.mock("../../../../auth/auth-context.js", () => ({
  useAuth: () => ({ agentId: "human-agent-self" }),
}));
vi.mock("../../../../lib/use-agent-name-map.js", () => ({
  useAgentNameMap: () => (id: string | null | undefined) => {
    if (id === "agent-1") return "Kael";
    if (id === "agent-2") return "Design Critique";
    return id ?? "unknown";
  },
}));

let root: Root | null = null;

function attention(overrides: Partial<Attention> & { id: string; subject: string }): Attention {
  return {
    id: overrides.id,
    originAgentId: overrides.originAgentId ?? "agent-1",
    originChatId: overrides.originChatId ?? "chat-1",
    targetHumanId: overrides.targetHumanId ?? "human-agent-self",
    subject: overrides.subject,
    body: overrides.body ?? "Please choose **one** rollout path.",
    requiresResponse: overrides.requiresResponse ?? true,
    state: overrides.state ?? "open",
    response: overrides.response ?? null,
    respondedBy: overrides.respondedBy ?? null,
    respondedAt: overrides.respondedAt ?? null,
    cancelled: overrides.cancelled ?? false,
    cancelledReason: overrides.cancelledReason ?? null,
    metadata: overrides.metadata ?? {},
    createdAt: overrides.createdAt ?? "2026-05-28T11:55:00.000Z",
    closedAt: overrides.closedAt ?? null,
  };
}

function createClient(rows: Attention[]): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(attentionsInChatQueryKey("chat-1"), rows);
  return queryClient;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderDom(element: ReactElement, rows: Attention[]): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<QueryClientProvider client={createClient(rows)}>{element}</QueryClientProvider>);
  });
  await flush();
  return container;
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

function buttonByText(rootNode: ParentNode, text: string): HTMLButtonElement {
  const button = [...rootNode.querySelectorAll("button")].find((el) => el.textContent?.includes(text));
  if (!button) throw new Error(`Missing button ${text}`);
  return button;
}

beforeEach(() => {
  document.body.innerHTML = "";
  attentionMocks.listAttentionsInChat.mockReset();
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      top: 80,
      left: 900,
      right: 1120,
      bottom: 112,
      width: 220,
      height: 32,
      x: 900,
      y: 80,
      toJSON: () => undefined,
    }),
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("AttentionsSection", () => {
  it("filters to my attentions, opens popovers, scrolls to the chat card, and closes with Escape", async () => {
    const target = document.createElement("div");
    target.dataset.attentionId = "ask-1";
    document.body.appendChild(target);
    const rows = [
      attention({ id: "old-hidden", subject: "Hidden old ask", createdAt: "2026-05-28T10:00:00.000Z" }),
      attention({ id: "ask-1", subject: "Choose rollout scope", createdAt: "2026-05-28T11:59:00.000Z" }),
      attention({
        id: "notify-1",
        subject: "FYI only",
        requiresResponse: false,
        state: "closed",
        body: "Deployment note.",
        createdAt: "2026-05-28T11:58:00.000Z",
        closedAt: "2026-05-28T11:58:30.000Z",
      }),
      attention({
        id: "closed-1",
        subject: "Answered ask",
        state: "closed",
        response: "Ship now.",
        cancelled: true,
        cancelledReason: "superseded",
        createdAt: "2026-05-28T11:57:00.000Z",
        closedAt: "2026-05-28T11:58:00.000Z",
      }),
      attention({
        id: "other-target",
        subject: "Not mine",
        targetHumanId: "human-agent-alice",
        createdAt: "2026-05-28T12:00:00.000Z",
      }),
    ];
    const container = await renderDom(<AttentionsSection chatId="chat-1" />, rows);

    expect(container.textContent).toContain("Attention");
    expect(container.textContent).toContain("2");
    expect(container.textContent).toContain("Choose rollout scope");
    expect(container.textContent).toContain("FYI only");
    expect(container.textContent).toContain("Answered ask");
    expect(container.textContent).not.toContain("Not mine");

    await click(buttonByText(container, "Choose rollout scope"));
    expect(document.body.textContent).toContain("Please choose");
    await click(buttonByText(document.body, "Go to chat"));
    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(document.body.textContent).not.toContain("Please choose");

    await click(buttonByText(container, "Answered ask"));
    expect(document.body.textContent).toContain("Human reply");
    expect(document.body.textContent).toContain("Ship now.");
    expect(document.body.textContent).toContain("Cancelled");
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();
    expect(document.body.textContent).not.toContain("Human reply");

    await click(buttonByText(container, "FYI only"));
    expect(document.body.textContent).toContain("Deployment note.");
    await click(document.body.querySelector('button[aria-label="Close popover"]'));
    expect(document.body.textContent).not.toContain("Deployment note.");
  });

  it("renders nothing when there are no relevant attentions", async () => {
    const container = await renderDom(<AttentionsSection chatId="chat-1" />, [
      attention({ id: "other", subject: "Other target", targetHumanId: "human-agent-alice" }),
    ]);

    expect(container.textContent).toBe("");
  });
});
