// @vitest-environment happy-dom

import {
  AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES,
  type AgentResourcesOutput,
  type AgentTemplateAdoptionSummary,
} from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client.js";
import { ToastProvider } from "../../../components/ui/toast.js";
import { useAgentResources } from "../capability-section.js";
import { TemplateProvenance } from "../responsibilities-section.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const templateMocks = vi.hoisted(() => ({
  listAgentTemplates: vi.fn(),
  updateAgentTemplates: vi.fn(),
}));

const analyticsMocks = vi.hoisted(() => ({
  trackEvent: vi.fn(),
}));

const resourceMocks = vi.hoisted(() => ({
  getAgentResources: vi.fn(),
}));

vi.mock("../../../api/agent-templates.js", () => templateMocks);
vi.mock("../../../api/agent-resources.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/agent-resources.js")>()),
  ...resourceMocks,
}));
vi.mock("../../../analytics.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../analytics.js")>()),
  ...analyticsMocks,
}));

const TEMPLATE_A_ID = "0190f000-0000-7000-8000-000000000001";
const TEMPLATE_B_ID = "0190f000-0000-7000-8000-000000000002";
const TEMPLATE_C_ID = "0190f000-0000-7000-8000-000000000003";

let root: Root | null = null;

function summary(input: {
  id: string;
  status?: "active" | "retired" | "missing";
  name?: string;
  purpose?: string;
  replacement?: { slug: string; name: string } | null;
}): AgentTemplateAdoptionSummary {
  if (input.status === "missing") {
    return { id: input.id, status: "missing", slug: null, name: null, public: null, replacement: null };
  }
  const base = {
    id: input.id,
    slug: input.name?.toLowerCase().replace(/[^a-z0-9]+/g, "-") ?? "pr-engineer",
    name: input.name ?? "PR Engineer",
    public: {
      tagline: "Ship review-ready PRs",
      purpose: input.purpose ?? "Ships review-ready pull requests.",
      targetUsers: "Engineering teams",
      userValue: "Reliable delivery",
      instructionsSummary: "Review and implementation guidance",
      toolsAndSkillsSummary: "GitHub and coding skills",
    },
  };
  if (input.status === "retired") {
    return { ...base, status: "retired", replacement: input.replacement ?? null };
  }
  return { ...base, status: "active", replacement: null };
}

function resources(overrides: Partial<AgentResourcesOutput> = {}): AgentResourcesOutput {
  return {
    version: overrides.version ?? 7,
    templateIds: overrides.templateIds ?? [],
    adoptedTemplates: overrides.adoptedTemplates ?? [],
    effective: overrides.effective ?? {
      version: overrides.version ?? 7,
      repos: [],
      prompts: [],
      skills: [],
      mcp: [],
      unavailable: [],
    },
    bindings: overrides.bindings ?? [],
    availableTeamResources: overrides.availableTeamResources ?? [],
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForCondition(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(message);
}

async function render(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ToastProvider>{element}</ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
  return container;
}

function renderSection(props: {
  canManage?: boolean;
  agentStatus?: string;
  templateIds?: string[];
  adoptedTemplates?: AgentTemplateAdoptionSummary[];
  version?: number;
}): Promise<HTMLElement> {
  return render(
    <TemplateProvenance
      agentUuid="agent-1"
      agentStatus={props.agentStatus ?? "active"}
      canManage={props.canManage ?? true}
      templateIds={props.templateIds ?? []}
      adoptedTemplates={props.adoptedTemplates ?? []}
      version={props.version ?? 7}
    />,
  );
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

function exactButton(text: string): HTMLButtonElement | null {
  return [...document.body.querySelectorAll("button")].find((button) => button.textContent?.trim() === text) ?? null;
}

describe("TemplateProvenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
  });

  it("renders nothing when the agent has no adopted template sources", async () => {
    const container = await renderSection({ templateIds: [] });
    expect(container.textContent).toBe("");
    expect(container.querySelector("section")).toBeNull();
  });

  it("renders one quiet source line in stable visible-name order with missing summaries last", async () => {
    await renderSection({
      templateIds: [TEMPLATE_A_ID, TEMPLATE_C_ID, TEMPLATE_B_ID],
      adoptedTemplates: [
        summary({ id: TEMPLATE_A_ID, name: "PR Engineer" }),
        summary({ id: TEMPLATE_B_ID, name: "Docs Writer", status: "retired", replacement: null }),
      ],
    });

    expect(document.body.querySelector("h3")).toBeNull();
    expect(document.body.querySelector('[data-slot="template-provenance"]')?.textContent).toContain(
      "Docs Writer template, PR Engineer template, and an unavailable template",
    );
    expect(document.body.textContent).not.toContain("Retired");
    expect(document.body.textContent).not.toContain("Ship review-ready PRs");
    expect([...document.body.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
      "/templates/docs-writer",
      "/templates/pr-engineer",
    ]);
  });

  it("shows one compact source menu only to managers of active agents", async () => {
    await renderSection({
      canManage: true,
      templateIds: [TEMPLATE_A_ID],
      adoptedTemplates: [summary({ id: TEMPLATE_A_ID })],
    });
    expect(document.body.querySelector('button[aria-label="Manage template sources"]')).toBeTruthy();

    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    await renderSection({
      canManage: false,
      templateIds: [TEMPLATE_A_ID],
      adoptedTemplates: [summary({ id: TEMPLATE_A_ID })],
    });
    expect(document.body.querySelector('button[aria-label="Manage template sources"]')).toBeNull();

    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    await renderSection({
      canManage: true,
      agentStatus: "suspended",
      templateIds: [TEMPLATE_A_ID],
      adoptedTemplates: [summary({ id: TEMPLATE_A_ID })],
    });
    expect(document.body.querySelector('button[aria-label="Manage template sources"]')).toBeNull();
  });

  it("gives every missing source a distinct accessible removal name", async () => {
    await renderSection({
      templateIds: [TEMPLATE_A_ID, TEMPLATE_B_ID],
      adoptedTemplates: [],
    });

    await click(document.body.querySelector('button[aria-label="Manage template sources"]'));
    expect(exactButton(`Remove unavailable template ${TEMPLATE_A_ID}`)).toBeTruthy();
    expect(exactButton(`Remove unavailable template ${TEMPLATE_B_ID}`)).toBeTruthy();
  });

  it("removes only the selected source without loading the catalog", async () => {
    templateMocks.updateAgentTemplates.mockResolvedValue(
      resources({
        version: 8,
        templateIds: [TEMPLATE_A_ID],
        adoptedTemplates: [summary({ id: TEMPLATE_A_ID, name: "PR Engineer" })],
      }),
    );
    await renderSection({
      templateIds: [TEMPLATE_A_ID, TEMPLATE_B_ID],
      adoptedTemplates: [
        summary({ id: TEMPLATE_A_ID, name: "PR Engineer" }),
        summary({ id: TEMPLATE_B_ID, name: "Docs Writer" }),
      ],
    });

    await click(document.body.querySelector('button[aria-label="Manage template sources"]'));
    await click(exactButton("Remove Docs Writer template"));
    expect(document.body.textContent).toContain("Remove template source?");
    expect(document.body.textContent).toContain(
      "Only this agent’s bindings imported from Docs Writer template will be removed. Team Resources will remain available.",
    );
    expect(templateMocks.listAgentTemplates).not.toHaveBeenCalled();
    await click(exactButton("Remove source"));

    await waitForCondition(
      () => templateMocks.updateAgentTemplates.mock.calls.length === 1,
      "Expected responsibility removal",
    );
    expect(templateMocks.updateAgentTemplates).toHaveBeenCalledWith("agent-1", {
      expectedVersion: 7,
      templateIds: [TEMPLATE_A_ID],
    });
    expect(analyticsMocks.trackEvent).toHaveBeenCalledWith("agent_template_replace_set", { result: "success" });
  });

  it("disappears after the last template source is removed", async () => {
    resourceMocks.getAgentResources.mockResolvedValue(
      resources({ templateIds: [TEMPLATE_A_ID], adoptedTemplates: [summary({ id: TEMPLATE_A_ID })] }),
    );
    templateMocks.updateAgentTemplates.mockResolvedValue(resources({ version: 8 }));

    function Harness() {
      const current = useAgentResources("agent-1", { enabled: true });
      if (!current.data) return null;
      return (
        <TemplateProvenance
          agentUuid="agent-1"
          agentStatus="active"
          canManage
          templateIds={current.data.templateIds}
          adoptedTemplates={current.data.adoptedTemplates}
          version={current.data.version}
        />
      );
    }

    const container = await render(<Harness />);
    await waitForCondition(() => container.textContent?.includes("PR Engineer") ?? false, "Expected template source");
    await click(document.body.querySelector('button[aria-label="Manage template sources"]'));
    await click(exactButton("Remove PR Engineer template"));
    await click(exactButton("Remove source"));
    await waitForCondition(() => container.textContent === "", "Expected source line to disappear");
  });

  it("refreshes and asks for a retry on a version conflict", async () => {
    templateMocks.updateAgentTemplates.mockRejectedValue(
      new ApiError(
        409,
        "Agent templates version mismatch",
        undefined,
        AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES.VERSION_CONFLICT,
      ),
    );
    await renderSection({
      templateIds: [TEMPLATE_A_ID],
      adoptedTemplates: [summary({ id: TEMPLATE_A_ID })],
    });
    await click(document.body.querySelector('button[aria-label="Manage template sources"]'));
    await click(exactButton("Remove PR Engineer template"));
    await click(exactButton("Remove source"));
    await waitForCondition(
      () => document.body.textContent?.includes("refreshed — review and remove again") ?? false,
      "Expected version conflict guidance",
    );
    expect(analyticsMocks.trackEvent).toHaveBeenCalledWith("agent_template_replace_set", { result: "failure" });
  });
});
