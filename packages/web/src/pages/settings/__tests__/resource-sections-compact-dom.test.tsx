// @vitest-environment happy-dom

import type { ResourceRow } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../../components/ui/toast.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const authMock = vi.hoisted(() => ({ value: { role: "admin" as "admin" | "member" } }));
const resourceMocks = vi.hoisted(() => ({
  listTeamResources: vi.fn(),
  previewResourceImpact: vi.fn(),
  retireResource: vi.fn(),
}));

vi.mock("../../../auth/auth-context.js", () => ({ useAuth: () => authMock.value }));
vi.mock("../../../api/resources.js", async () => {
  const actual = await vi.importActual<typeof import("../../../api/resources.js")>("../../../api/resources.js");
  return { ...actual, ...resourceMocks };
});

const NOW = "2026-07-16T00:00:00.000Z";

function repo(id: string): ResourceRow {
  return {
    id,
    organizationId: "org-1",
    type: "repo",
    scope: "team",
    ownerAgentId: null,
    name: id,
    repoCanonicalKey: `git.example.com/acme/${id}`,
    defaultEnabled: "recommended",
    status: "active",
    payload: { url: `https://git.example.com/acme/${id}.git` },
    createdBy: "member-1",
    updatedBy: "member-1",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function client(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } },
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderSections(): Promise<{ container: HTMLElement; root: Root }> {
  const { ResourceTypeSections } = await import("../resource-sections.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client()}>
        <ToastProvider>
          <ResourceTypeSections
            types={["repo"]}
            titleFor={() => "Code repositories"}
            descriptionFor={() => "Repositories your agents can read and change."}
            addLabelFor={() => "Add repository"}
            emptyLabelFor={() => "No code repositories configured yet."}
            compactLimit={3}
          />
        </ToastProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
  return { container, root };
}

async function click(button: HTMLButtonElement | null): Promise<void> {
  if (!button) throw new Error("Expected button");
  await act(async () => button.click());
  await flush();
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  authMock.value = { role: "admin" };
  resourceMocks.listTeamResources.mockResolvedValue([repo("alpha"), repo("beta"), repo("gamma"), repo("delta")]);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ResourceTypeSections compact mode", () => {
  it("shows three rows until an accessible View all control expands the section", async () => {
    const { container, root } = await renderSections();
    expect(container.textContent).toContain("Code repositories");
    expect(container.textContent).toContain("Repositories your agents can read and change.");
    expect(container.querySelector('button[aria-label="Add repository"]')).not.toBeNull();
    expect(container.textContent).toContain("alpha");
    expect(container.textContent).toContain("beta");
    expect(container.textContent).toContain("gamma");
    expect(container.textContent).not.toContain("delta");

    const expand = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.includes("View all (4)"),
    );
    expect(expand?.getAttribute("aria-expanded")).toBe("false");
    await click(expand ?? null);
    expect(container.textContent).toContain("delta");

    const collapse = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.includes("Show less"),
    );
    expect(collapse?.getAttribute("aria-expanded")).toBe("true");
    await click(collapse ?? null);
    expect(container.textContent).not.toContain("delta");
    await act(async () => root.unmount());
  });

  it("uses the host's explicit empty and add copy", async () => {
    resourceMocks.listTeamResources.mockResolvedValue([]);
    const { container, root } = await renderSections();
    expect(container.textContent).toContain("No code repositories configured yet.");
    expect(container.querySelector('button[aria-label="Add repository"]')).not.toBeNull();
    expect(container.textContent).not.toContain("View all");
    await act(async () => root.unmount());
  });
});
