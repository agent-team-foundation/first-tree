// @vitest-environment happy-dom

import type { Agent, UsageByAgentRow } from "@first-tree/shared";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRow, HumanRow, RowAction, TeamTableProps } from "../team-table.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type MediaController = {
  setMatches: (matches: boolean) => void;
};

const mediaControllers: MediaController[] = [];

function installMatchMedia(initialMatches: boolean): void {
  mediaControllers.length = 0;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => {
      let matches = initialMatches;
      const listeners = new Set<(event: MediaQueryListEvent) => void>();
      const controller = {
        setMatches: (next: boolean) => {
          matches = next;
          const event = { matches, media: query } as MediaQueryListEvent;
          for (const listener of listeners) listener(event);
        },
      };
      mediaControllers.push(controller);
      return {
        get matches() {
          return matches;
        },
        media: query,
        onchange: null,
        addEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
        removeEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) =>
          listeners.delete(listener),
        addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
        removeListener: (listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
        dispatchEvent: () => false,
      };
    },
  });
}

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    uuid: overrides.uuid ?? "agent-1",
    name: overrides.name ?? "nova",
    displayName: overrides.displayName ?? "Nova",
    type: overrides.type ?? "agent",
    managerId: overrides.managerId ?? "member-self",
    visibility: overrides.visibility ?? "organization",
    avatarColorToken: overrides.avatarColorToken ?? null,
    avatarImageUrl: overrides.avatarImageUrl ?? null,
    status: overrides.status ?? "active",
    organizationId: overrides.organizationId ?? "org-1",
    delegateMention: overrides.delegateMention ?? null,
    inboxId: overrides.inboxId ?? `${overrides.uuid ?? "agent-1"}-inbox`,
    metadata: overrides.metadata ?? {},
    source: overrides.source ?? "portal",
    clientId: overrides.clientId ?? "client-1",
    runtimeProvider: overrides.runtimeProvider ?? "claude-code",
    runtimeState: overrides.runtimeState ?? "idle",
    createdAt: overrides.createdAt ?? "2026-05-28T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-05-28T12:00:00.000Z",
  };
}

function usage(agentId: string, overrides: Partial<UsageByAgentRow> = {}): UsageByAgentRow {
  return {
    agentId,
    inputTokens: overrides.inputTokens ?? 1_000,
    cachedInputTokens: overrides.cachedInputTokens ?? 2_000,
    outputTokens: overrides.outputTokens ?? 500,
    turns: overrides.turns ?? 2,
  };
}

function createProps(overrides: Partial<TeamTableProps> = {}): TeamTableProps {
  const nova: AgentRow = {
    kind: "agent",
    agent: agent({ uuid: "agent-1", name: "nova", displayName: "Nova", runtimeState: "idle" }),
    managerLabel: "Gandy",
    isOwnedBySelf: true,
  };
  const design: AgentRow = {
    kind: "agent",
    agent: agent({
      uuid: "agent-2",
      name: "design",
      displayName: "Design",
      managerId: "member-alice",
      visibility: "private",
      clientId: "client-2",
      runtimeProvider: "codex",
      runtimeState: "working",
    }),
    managerLabel: "Alice",
    isOwnedBySelf: false,
  };
  const humans: HumanRow[] = [
    {
      kind: "human",
      id: "member-self",
      agentId: "human-self",
      username: "gandy",
      displayName: "Gandy",
      avatarUrl: "https://avatars.example.test/u/gandy.png",
      role: "admin",
      isSelf: true,
      delegate: { uuid: "agent-1", name: "nova", displayName: "Nova", colorToken: null, avatarImageUrl: null },
      canEditDelegate: true,
      lastActiveLabel: "active now",
    },
    {
      kind: "human",
      id: "member-alice",
      agentId: "human-alice",
      username: "alice",
      displayName: "Alice",
      avatarUrl: null,
      role: "member",
      isSelf: false,
      delegate: null,
      canEditDelegate: false,
      lastActiveLabel: null,
    },
  ];
  return {
    publicAgents: [nova],
    privateAgents: [design],
    humans,
    isAdmin: true,
    dimPrivateOwner: false,
    agentCount: 2,
    clientHostMap: new Map([
      ["client-1", "gandy-macbook"],
      ["client-2", "alice-linux"],
    ]),
    usageByAgentId: new Map([
      ["agent-1", usage("agent-1")],
      ["agent-2", usage("agent-2", { turns: 1, inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 })],
    ]),
    usageLoading: false,
    onChat: vi.fn(),
    onAgentDetails: vi.fn(),
    getAgentMenuActions: (row) => (row.isOwnedBySelf ? [{ key: "suspend", label: "Suspend", onSelect: vi.fn() }] : []),
    onHumanDetails: vi.fn(),
    getHumanMenuActions: (row) =>
      row.isSelf ? [] : [{ key: "remove", label: "Remove from org", destructive: true, onSelect: vi.fn() }],
    delegateCandidates: [
      agent({ uuid: "agent-1", name: "nova", displayName: "Nova", visibility: "private" }),
      agent({ uuid: "agent-3", name: "scout", displayName: "Scout", visibility: "private" }),
    ],
    onSetDelegate: vi.fn(),
    searchActive: false,
    agentFilter: "all",
    onAgentFilter: vi.fn(),
    onInvite: vi.fn(),
    ...overrides,
  };
}

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

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected an element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(text)) ?? null;
}

beforeEach(() => {
  document.body.innerHTML = "";
  installMatchMedia(true);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("TeamTable", () => {
  it("renders desktop rows, actions, delegate selector, and row open handlers", async () => {
    const { TeamTable } = await import("../team-table.js");
    const props = createProps();

    const { container, root } = await renderDom(<TeamTable {...props} />);
    expect(container.textContent).toContain("Agent teammates");
    expect(container.textContent).toContain("Human teammates");
    expect(container.textContent).toContain("Nova");
    expect(container.textContent).toContain("Design");
    expect(container.textContent).toContain("1.5K");
    expect(container.textContent).toContain("Online");
    expect(container.textContent).toContain("Gandy");
    expect(container.textContent).toContain("Admin");
    expect(container.textContent).toContain("—");
    expect(container.querySelector('img[alt="Gandy"]')?.getAttribute("src")).toBe(
      "https://avatars.example.test/u/gandy.png",
    );

    await click(container.querySelector('[aria-label="Open Nova"]'));
    expect(props.onAgentDetails).toHaveBeenCalledWith("agent-1");

    await click(container.querySelector('button[aria-label="Actions for Nova"]'));
    expect(container.textContent).toContain("Chat");
    expect(container.textContent).toContain("Suspend");
    await click(buttonByText(container, "Chat"));
    expect(props.onChat).toHaveBeenCalledWith("agent-1");

    await click(container.querySelector('button[title="Change delegate"]'));
    expect(document.body.textContent).toContain("Remove delegate");
    expect(document.body.textContent).toContain("Scout");
    await click(buttonByText(document.body, "Scout"));
    expect(props.onSetDelegate).toHaveBeenCalledWith("human-self", "agent-3");

    await click(container.querySelector('button[aria-label="Actions for Alice"]'));
    expect(container.textContent).toContain("Remove from org");

    await act(async () => root.unmount());
  });

  it("renders compact rows, loading/empty states, keyboard open, and no-candidate delegate copy", async () => {
    installMatchMedia(false);
    const { TeamTable } = await import("../team-table.js");
    const props = createProps({
      publicAgents: [],
      privateAgents: [],
      humans: [
        {
          kind: "human",
          id: "member-self",
          agentId: "human-self",
          username: "gandy",
          displayName: "Gandy",
          avatarUrl: "https://avatars.example.test/u/gandy-compact.png",
          role: "member",
          isSelf: true,
          delegate: null,
          canEditDelegate: true,
          lastActiveLabel: null,
        },
      ],
      agentCount: 0,
      usageByAgentId: null,
      usageLoading: true,
      delegateCandidates: [],
      searchActive: true,
      getAgentMenuActions: (() => []) as (row: AgentRow) => RowAction[],
    });

    const { container, root } = await renderDom(<TeamTable {...props} />);
    expect(container.textContent).toContain("No agents match this search.");
    expect(container.textContent).toContain("Set delegate");
    expect(container.querySelector('img[alt="Gandy"]')?.getAttribute("src")).toBe(
      "https://avatars.example.test/u/gandy-compact.png",
    );

    const selfRow = container.querySelector('[aria-label="Open Gandy"]');
    await act(async () => {
      selfRow?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(props.onHumanDetails).toHaveBeenCalledWith(props.humans[0]);

    await click(container.querySelector('button[title="Set delegate"]'));
    expect(document.body.textContent).toContain("Only team-visible agents can be a delegate.");
    await click(buttonByText(document.body, "Remove delegate"));
    expect(props.onSetDelegate).toHaveBeenCalledWith("human-self", null);

    await act(async () => {
      mediaControllers.at(-1)?.setMatches(true);
    });
    await flush();
    expect(container.textContent).toContain("NameOwnerRuns onUsage");

    await act(async () => root.unmount());
  });
});
