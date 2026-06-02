// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentIdentityMap, useAgentNameMap, useAgentSlugToIdMap } from "../use-agent-name-map.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const agentMocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listManagedAgents: vi.fn(),
}));

vi.mock("../../api/agents.js", () => agentMocks);

type CapturedMaps = {
  nameFor: ReturnType<typeof useAgentNameMap>;
  slugToId: ReturnType<typeof useAgentSlugToIdMap>;
  identityFor: ReturnType<typeof useAgentIdentityMap>;
};

let root: Root | null = null;
let captured: CapturedMaps | null = null;

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForCondition(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(message);
}

function Probe() {
  captured = {
    nameFor: useAgentNameMap(),
    slugToId: useAgentSlugToIdMap(),
    identityFor: useAgentIdentityMap(),
  };
  return <div>{captured.nameFor("agent-org")}</div>;
}

async function renderProbe(children: ReactNode = <Probe />): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<QueryClientProvider client={createClient()}>{children}</QueryClientProvider>);
  });
  return container;
}

beforeEach(() => {
  vi.clearAllMocks();
  captured = null;
  document.body.innerHTML = "";
  agentMocks.listAgents.mockResolvedValue({
    items: [
      {
        uuid: "agent-org",
        name: "kael",
        displayName: "Org Kael",
        avatarImageUrl: "/org.webp",
        avatarColorToken: "hue-3",
      },
      {
        uuid: "agent-collision",
        name: "winner",
        displayName: "Org Wins",
        avatarImageUrl: null,
        avatarColorToken: "hue-5",
      },
    ],
    nextCursor: null,
  });
  agentMocks.listManagedAgents.mockResolvedValue([
    {
      uuid: "agent-managed",
      name: "poe",
      displayName: "Managed Poe",
      avatarImageUrl: "/managed.webp",
    },
    {
      uuid: "agent-collision",
      name: "loser",
      displayName: "Managed Loses",
      avatarImageUrl: "/loser.webp",
    },
  ]);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function maps(): CapturedMaps {
  if (!captured) throw new Error("maps were not captured");
  return captured;
}

describe("agent name maps", () => {
  it("merges org-scoped and managed agents with org data winning collisions", async () => {
    const container = await renderProbe();

    expect(maps().nameFor(null)).toBe("\u2014");
    expect(maps().nameFor(undefined)).toBe("\u2014");
    expect(maps().nameFor("missing")).toBe("missing");
    expect(maps().slugToId(null)).toBeNull();
    expect(maps().identityFor(undefined)).toBeNull();

    await waitForCondition(() => container.textContent === "Org Kael", "expected org agent to load");

    expect(maps().nameFor("agent-managed")).toBe("Managed Poe");
    expect(maps().nameFor("agent-collision")).toBe("Org Wins");
    expect(maps().slugToId("POE")).toBe("agent-managed");
    expect(maps().slugToId("winner")).toBe("agent-collision");
    expect(maps().slugToId("loser")).toBe("agent-collision");
    expect(maps().slugToId("missing")).toBeNull();
    expect(maps().identityFor("agent-managed")).toEqual({
      name: "poe",
      displayName: "Managed Poe",
      avatarImageUrl: "/managed.webp",
      avatarColorToken: null,
    });
    expect(maps().identityFor("agent-collision")).toEqual({
      name: "winner",
      displayName: "Org Wins",
      avatarImageUrl: null,
      avatarColorToken: "hue-5",
    });
    expect(maps().identityFor("missing")).toBeNull();
  });

  it("skips nameless slugs while keeping display labels addressable by uuid", async () => {
    agentMocks.listAgents.mockResolvedValueOnce({
      items: [{ uuid: "agent-null-name", name: null, displayName: "No Slug", avatarImageUrl: null }],
      nextCursor: null,
    });
    agentMocks.listManagedAgents.mockResolvedValueOnce([
      { uuid: "managed-null-name", name: null, displayName: "Managed No Slug", avatarImageUrl: null },
    ]);

    await renderProbe();
    await waitForCondition(
      () => maps().nameFor("agent-null-name") === "No Slug",
      "expected nameless org agent to load",
    );

    expect(maps().nameFor("agent-null-name")).toBe("No Slug");
    expect(maps().nameFor("managed-null-name")).toBe("Managed No Slug");
    expect(maps().slugToId("no-slug")).toBeNull();
    expect(maps().identityFor("agent-null-name")).toEqual({
      name: null,
      displayName: "No Slug",
      avatarImageUrl: null,
      avatarColorToken: null,
    });
  });
});
