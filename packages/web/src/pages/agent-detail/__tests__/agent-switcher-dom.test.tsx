// @vitest-environment happy-dom

import type { Agent } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const agentMocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listAllAgents: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  value: { memberId: "member-self", role: "member", organizationId: "org-1" } as {
    memberId: string;
    role: string;
    organizationId: string;
  },
}));

vi.mock("../../../api/agents.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/agents.js")>()),
  ...agentMocks,
}));

vi.mock("../../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

const NOW = "2026-05-28T12:00:00.000Z";

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    uuid: overrides.uuid ?? "agent-1",
    name: overrides.name ?? "vega",
    displayName: overrides.displayName ?? "Vega",
    type: overrides.type ?? "agent",
    managerId: overrides.managerId ?? "member-self",
    visibility: overrides.visibility ?? "organization",
    avatarColorToken: overrides.avatarColorToken ?? null,
    avatarImageUrl: overrides.avatarImageUrl ?? null,
    status: overrides.status ?? "active",
    organizationId: overrides.organizationId ?? "org-1",
    delegateMention: overrides.delegateMention ?? null,
    inboxId: overrides.inboxId ?? "inbox-1",
    metadata: overrides.metadata ?? {},
    source: overrides.source ?? "portal",
    clientId: overrides.clientId === undefined ? "client-1" : overrides.clientId,
    runtimeProvider: overrides.runtimeProvider ?? "claude-code",
    runtimeState: overrides.runtimeState === undefined ? "idle" : overrides.runtimeState,
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

let root: Root | null = null;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderSwitcher(
  current: Agent = agent(),
): Promise<{ onSelect: ReturnType<typeof vi.fn>; container: HTMLElement }> {
  const { AgentSwitcher } = await import("../agent-switcher.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const onSelect = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <AgentSwitcher currentAgent={current} onSelect={onSelect} />
      </QueryClientProvider>,
    );
  });
  await flush();
  return { onSelect, container };
}

function trigger(): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
  if (!found) throw new Error("Expected the switcher trigger");
  return found;
}

function rows(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]'));
}

function rowLabels(): string[] {
  return rows().map((row) => row.textContent?.trim() ?? "");
}

async function click(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error("Expected an element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function setValue(element: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

async function press(element: Element, key: string): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  await flush();
}

async function open(): Promise<void> {
  await click(trigger());
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  authMock.value = { memberId: "member-self", role: "member", organizationId: "org-1" };
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  agentMocks.listAgents.mockResolvedValue({
    items: [
      agent(),
      agent({ uuid: "agent-2", name: "nova", displayName: "Nova" }),
      agent({ uuid: "member-mirror", name: "gandy", displayName: "Gandy", type: "human" }),
    ],
    nextCursor: null,
  });
  agentMocks.listAllAgents.mockResolvedValue({ items: [], nextCursor: null });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("AgentSwitcher", () => {
  it("keeps the breadcrumb resting state and only adds a menu affordance", async () => {
    await renderSwitcher();
    expect(trigger().textContent).toBe("Vega");
    expect(trigger().getAttribute("aria-current")).toBe("page");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    // Nothing is fetched until the user actually asks to switch.
    expect(agentMocks.listAgents).not.toHaveBeenCalled();

    await open();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(agentMocks.listAgents).toHaveBeenCalledTimes(1);
  });

  it("lists agents only, marks the open one, and leaves handles off unique names", async () => {
    await renderSwitcher();
    await open();

    expect(rowLabels()).toEqual(["Nova", "Vega"]);
    expect(rows().map((row) => row.getAttribute("aria-checked"))).toEqual(["false", "true"]);
  });

  it("adds the handle only where display names collide", async () => {
    agentMocks.listAgents.mockResolvedValue({
      items: [
        agent(),
        agent({ uuid: "agent-2", name: "vega-2", displayName: "Vega" }),
        agent({ uuid: "agent-3", name: "nova", displayName: "Nova" }),
      ],
      nextCursor: null,
    });
    await renderSwitcher();
    await open();

    expect(rowLabels()).toEqual(["Nova", "Vega@vega", "Vega@vega-2"]);
  });

  it("keeps the open agent in the list when the roster query cannot see it", async () => {
    agentMocks.listAgents.mockResolvedValue({
      items: [agent({ uuid: "agent-2", name: "nova", displayName: "Nova" })],
      nextCursor: null,
    });
    await renderSwitcher(agent({ uuid: "agent-private", name: "orion", displayName: "Orion" }));
    await open();

    expect(rowLabels()).toEqual(["Nova", "Orion"]);
    expect(rows()[1]?.getAttribute("aria-checked")).toBe("true");
  });

  it("reads the admin roster when the viewer is an admin", async () => {
    authMock.value = { memberId: "member-self", role: "admin", organizationId: "org-1" };
    agentMocks.listAllAgents.mockResolvedValue({
      items: [agent(), agent({ uuid: "agent-9", name: "private", displayName: "Someone's private agent" })],
      nextCursor: null,
    });
    await renderSwitcher();
    await open();

    expect(agentMocks.listAgents).not.toHaveBeenCalled();
    expect(rowLabels()).toEqual(["Someone's private agent", "Vega"]);
  });

  it("reports the picked agent and closes, but treats the open agent as a no-op", async () => {
    const { onSelect } = await renderSwitcher();
    await open();
    // Rows are ["Nova", "Vega"]; the open agent is Vega.
    await click(rows()[0]);

    expect(onSelect).toHaveBeenCalledWith("agent-2");
    expect(document.querySelector('div[role="dialog"]')).toBeNull();

    await open();
    await click(rows()[1]);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(document.querySelector('div[role="dialog"]')).toBeNull();
  });

  it("opens on the current agent and moves through the list with the arrow keys", async () => {
    const { onSelect } = await renderSwitcher(agent({ uuid: "agent-2", name: "nova", displayName: "Nova" }));
    await open();

    // Focus lands on the checked row, not blindly on the first one.
    expect(rowLabels()).toEqual(["Nova", "Vega"]);
    expect(document.activeElement).toBe(rows()[0]);

    await press(rows()[0] as Element, "ArrowUp");
    expect(document.activeElement).toBe(rows()[1]);
    await press(rows()[1] as Element, "ArrowDown");
    expect(document.activeElement).toBe(rows()[0]);
    await press(rows()[0] as Element, "End");
    expect(document.activeElement).toBe(rows()[1]);
    await press(rows()[1] as Element, "Home");
    expect(document.activeElement).toBe(rows()[0]);
    await press(rows()[0] as Element, "ArrowDown");
    expect(document.activeElement).toBe(rows()[1]);

    await click(document.activeElement);
    expect(onSelect).toHaveBeenCalledWith("agent-1");
  });

  it("reorders the API roster into the Team page's order", async () => {
    authMock.value = { memberId: "member-self", role: "admin", organizationId: "org-1" };
    agentMocks.listAllAgents.mockResolvedValue({
      // As the API returns it: createdAt DESC, mixed visibility and ownership.
      items: [
        agent({ uuid: "a1", name: "zeta", displayName: "Zeta", visibility: "private", managerId: "member-other" }),
        agent({ uuid: "a2", name: "alpha", displayName: "Alpha", managerId: "member-other" }),
        agent({ uuid: "a3", name: "mine-zulu", displayName: "Mine Zulu", managerId: "member-self" }),
        agent({
          uuid: "a4",
          name: "private-mine",
          displayName: "Private Mine",
          visibility: "private",
          managerId: "member-self",
        }),
        agent({ uuid: "a5", name: "beta", displayName: "Beta", managerId: "member-other" }),
      ],
      nextCursor: null,
    });
    await renderSwitcher(agent({ uuid: "a3", name: "mine-zulu", displayName: "Mine Zulu", managerId: "member-self" }));
    await open();

    expect(rowLabels()).toEqual(["Mine Zulu", "Alpha", "Beta", "Private Mine", "Zeta"]);
  });

  it("shows a filter only past the small-list threshold and narrows the rows", async () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      agent({ uuid: `agent-${i}`, name: `agent-${i}`, displayName: i === 8 ? "Zephyr" : `Agent ${i}` }),
    );
    agentMocks.listAgents.mockResolvedValue({ items: many, nextCursor: null });
    await renderSwitcher(agent({ uuid: "agent-0", name: "agent-0", displayName: "Agent 0" }));
    await open();

    const filter = document.querySelector<HTMLInputElement>('input[aria-label="Find an agent"]');
    expect(filter).toBeTruthy();
    expect(document.activeElement).toBe(filter);
    expect(rows()).toHaveLength(9);

    if (!filter) throw new Error("Expected the filter input");
    await setValue(filter, "zep");
    expect(rowLabels()).toEqual(["Zephyr"]);
  });

  it("hides the filter for a small roster", async () => {
    await renderSwitcher();
    await open();
    expect(document.querySelector('input[aria-label="Find an agent"]')).toBeNull();
  });

  it("commits the top match when Enter is pressed in the filter", async () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      agent({ uuid: `agent-${i}`, name: `agent-${i}`, displayName: i === 8 ? "Zephyr" : `Agent ${i}` }),
    );
    agentMocks.listAgents.mockResolvedValue({ items: many, nextCursor: null });
    const { onSelect } = await renderSwitcher(agent({ uuid: "agent-0", name: "agent-0", displayName: "Agent 0" }));
    await open();

    const filter = document.querySelector<HTMLInputElement>('input[aria-label="Find an agent"]');
    if (!filter) throw new Error("Expected the filter input");
    await setValue(filter, "zep");
    await press(filter as Element, "Enter");

    expect(onSelect).toHaveBeenCalledWith("agent-8");
  });

  it("keeps a failed roster load inside the panel and recovers on retry", async () => {
    agentMocks.listAgents.mockRejectedValueOnce(new Error("offline"));
    await renderSwitcher();
    await open();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn’t load agents.");
    expect(rows()).toHaveLength(0);
    // The page behind the panel is untouched — the trigger still reads the agent.
    expect(trigger().textContent).toBe("Vega");

    const retry = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Retry");
    expect(document.activeElement).toBe(retry);

    await click(retry);
    expect(rowLabels()).toEqual(["Nova", "Vega"]);
    // The Retry button that held focus is gone; the recovered list takes over
    // rather than dropping the keyboard on document.body.
    expect(document.activeElement).toBe(rows()[1]);
  });

  it("shows just the open agent when there is nothing to switch to", async () => {
    agentMocks.listAgents.mockResolvedValue({ items: [agent()], nextCursor: null });
    await renderSwitcher();
    await open();
    expect(rowLabels()).toEqual(["Vega"]);
    expect(rows()[0]?.getAttribute("aria-checked")).toBe("true");
  });
});
