// @vitest-environment happy-dom

import {
  AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES,
  type AgentTemplateAdoptionSummary,
  type AgentTemplatePublicTemplate,
} from "@first-tree/shared";
import { QueryClient, QueryClientProvider, QueryClient as VanillaQueryClient } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client.js";
import { ToastProvider } from "../../../components/ui/toast.js";
import { agentResourcesMutationHandlers, useAgentResources } from "../capability-section.js";
import { ResponsibilitiesSection } from "../responsibilities-section.js";

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

const NOW = "2026-05-28T12:00:00.000Z";
const TEMPLATE_A_ID = "0190f000-0000-7000-8000-000000000001";
const TEMPLATE_B_ID = "0190f000-0000-7000-8000-000000000002";
const TEMPLATE_C_ID = "0190f000-0000-7000-8000-000000000003";

let root: Root | null = null;

function summary(input: {
  id: string;
  status?: "active" | "retired" | "missing";
  name?: string;
  replacement?: { slug: string; name: string } | null;
}): AgentTemplateAdoptionSummary {
  const publicProfile = {
    tagline: "Ship review-ready PRs",
    purpose: "purpose",
    targetUsers: "users",
    userValue: "value",
    instructionsSummary: "instructions",
    toolsAndSkillsSummary: "tools",
  };
  if (input.status === "missing") {
    return { id: input.id, status: "missing", slug: null, name: null, public: null, replacement: null };
  }
  if (input.status === "retired") {
    return {
      id: input.id,
      status: "retired",
      slug: "pr-engineer",
      name: input.name ?? "PR Engineer",
      public: publicProfile,
      replacement: input.replacement ?? null,
    };
  }
  return {
    id: input.id,
    status: "active",
    slug: "pr-engineer",
    name: input.name ?? "PR Engineer",
    public: publicProfile,
    replacement: null,
  };
}

function publicTemplate(id: string, name: string): AgentTemplatePublicTemplate {
  return {
    id,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    name,
    status: "active",
    public: {
      tagline: `Tagline of ${name}`,
      purpose: "purpose",
      targetUsers: "users",
      userValue: "value",
      instructionsSummary: "instructions",
      toolsAndSkillsSummary: "tools",
    },
    updatedAt: NOW,
    replacement: null,
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForText(text: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (document.body.textContent?.includes(text)) return;
    await flush();
  }
  throw new Error(`Expected text "${text}". Body: ${document.body.textContent ?? ""}`);
}

async function waitForCondition(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(message);
}

function renderSection(props: {
  canManage?: boolean;
  agentStatus?: string;
  templateIds?: string[];
  adoptedTemplates?: AgentTemplateAdoptionSummary[];
  version?: number;
}): Promise<HTMLElement> {
  return render(
    <ResponsibilitiesSection
      agentUuid="agent-1"
      agentStatus={props.agentStatus ?? "active"}
      canManage={props.canManage ?? true}
      templateIds={props.templateIds ?? []}
      adoptedTemplates={props.adoptedTemplates ?? []}
      version={props.version ?? 7}
    />,
  );
}

async function render(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>{element}</ToastProvider>
      </QueryClientProvider>,
    );
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

function buttonByText(text: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll("button")].find((el) => el.textContent?.trim() === text);
  if (!button) throw new Error(`Missing button "${text}". Body: ${document.body.textContent ?? ""}`);
  return button;
}

describe("ResponsibilitiesSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    templateMocks.listAgentTemplates.mockResolvedValue({ templates: [publicTemplate(TEMPLATE_C_ID, "Docs Writer")] });
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
  });

  it("shows a clear empty state with zero responsibilities", async () => {
    await renderSection({ templateIds: [] });
    expect(document.body.textContent).toContain("No starting responsibilities yet.");
    expect(buttonByText("Add responsibility")).toBeTruthy();
  });

  it("renders active, retired, and missing states with safe summaries", async () => {
    await renderSection({
      templateIds: [TEMPLATE_A_ID, TEMPLATE_B_ID, TEMPLATE_C_ID],
      adoptedTemplates: [
        summary({ id: TEMPLATE_A_ID }),
        summary({
          id: TEMPLATE_B_ID,
          name: "Old Writer",
          status: "retired",
          replacement: { slug: "docs-writer", name: "Docs Writer" },
        }),
        summary({ id: TEMPLATE_C_ID, status: "missing" }),
      ],
    });
    const text = document.body.textContent ?? "";
    expect(text).toContain("PR Engineer");
    expect(text).not.toContain("Active");
    expect(text).toContain("Old Writer");
    expect(text).toContain("Retired");
    expect(text).toContain("Try Docs Writer");
    expect(text).toContain("Unavailable template");
    const labels = document.body.querySelectorAll('[data-slot="template-responsibility-label"]');
    expect(labels).toHaveLength(3);
    expect(labels[0]?.textContent).toBe("PR Engineerpurpose");
  });

  it("hides the edit affordance for read-only members", async () => {
    await renderSection({
      canManage: false,
      templateIds: [TEMPLATE_A_ID],
      adoptedTemplates: [summary({ id: TEMPLATE_A_ID })],
    });
    expect(document.body.textContent).toContain("PR Engineer");
    expect(
      [...document.body.querySelectorAll("button")].find((el) => el.textContent?.trim() === "Edit responsibilities"),
    ).toBeUndefined();
  });

  it("shows the edit button for an active manager and hides it when suspended", async () => {
    await renderSection({
      canManage: true,
      agentStatus: "active",
      templateIds: [TEMPLATE_A_ID],
      adoptedTemplates: [summary({ id: TEMPLATE_A_ID })],
    });
    expect(
      [...document.body.querySelectorAll("button")].find((el) => el.textContent?.trim() === "Edit responsibilities"),
    ).toBeDefined();
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    await renderSection({
      canManage: true,
      agentStatus: "suspended",
      templateIds: [TEMPLATE_A_ID],
      adoptedTemplates: [summary({ id: TEMPLATE_A_ID })],
    });
    expect(document.body.textContent).toContain("PR Engineer");
    expect(
      [...document.body.querySelectorAll("button")].find((el) => el.textContent?.trim() === "Edit responsibilities"),
    ).toBeUndefined();
  });

  it("saves a replace-set edit and shows the apply-before-next-action note", async () => {
    const updated = {
      version: 8,
      templateIds: [],
      adoptedTemplates: [],
      effective: { version: 8, repos: [], prompts: [], skills: [], mcp: [], unavailable: [] },
      bindings: [],
      availableTeamResources: [],
    };
    templateMocks.updateAgentTemplates.mockResolvedValue(updated);
    await renderSection({ templateIds: [TEMPLATE_A_ID], adoptedTemplates: [summary({ id: TEMPLATE_A_ID })] });

    await click(buttonByText("Edit responsibilities"));
    await waitForText("Edit responsibilities");
    await click(buttonByText("Remove"));
    await click(buttonByText("Save"));
    await waitForCondition(() => templateMocks.updateAgentTemplates.mock.calls.length === 1, "save not called");
    expect(templateMocks.updateAgentTemplates.mock.calls[0]).toEqual([
      "agent-1",
      { expectedVersion: 7, templateIds: [] },
    ]);
    await waitForText("Saved. It will apply before this agent's next action.");
    expect(analyticsMocks.trackEvent).toHaveBeenCalledWith("agent_template_replace_set", { result: "success" });
  });

  it("shows the neutral empty state after removing the last template", async () => {
    templateMocks.updateAgentTemplates.mockResolvedValue({
      version: 8,
      templateIds: [],
      adoptedTemplates: [],
      effective: { version: 8, repos: [], prompts: [], skills: [], mcp: [], unavailable: [] },
      bindings: [],
      availableTeamResources: [],
    });
    resourceMocks.getAgentResources.mockResolvedValue({
      version: 7,
      templateIds: [TEMPLATE_A_ID],
      adoptedTemplates: [summary({ id: TEMPLATE_A_ID })],
      effective: { version: 7, repos: [], prompts: [], skills: [], mcp: [], unavailable: [] },
      bindings: [],
      availableTeamResources: [],
    });
    function Harness() {
      const resources = useAgentResources("agent-1", { enabled: true });
      if (!resources.data) return null;
      return (
        <ResponsibilitiesSection
          agentUuid="agent-1"
          agentStatus="active"
          canManage
          templateIds={resources.data.templateIds}
          adoptedTemplates={resources.data.adoptedTemplates}
          version={resources.data.version}
        />
      );
    }
    await render(<Harness />);
    await waitForText("PR Engineer");
    await click(buttonByText("Edit responsibilities"));
    await waitForText("Edit responsibilities");
    await click(buttonByText("Remove"));
    await click(buttonByText("Save"));
    await waitForCondition(() => templateMocks.updateAgentTemplates.mock.calls.length === 1, "save not called");
    // The authoritative response written into the cache is the zero set; the
    // card shows the neutral current-state copy, not a created-from-scratch
    // claim.
    await waitForText("No starting responsibilities yet.");
    expect(document.body.textContent).not.toContain("created from scratch");
  });

  it("adds an active catalog template through the editor", async () => {
    templateMocks.updateAgentTemplates.mockResolvedValue({
      version: 8,
      templateIds: [TEMPLATE_A_ID, TEMPLATE_C_ID],
      adoptedTemplates: [summary({ id: TEMPLATE_A_ID }), summary({ id: TEMPLATE_C_ID, name: "Docs Writer" })],
      effective: { version: 8, repos: [], prompts: [], skills: [], mcp: [], unavailable: [] },
      bindings: [],
      availableTeamResources: [],
    });
    await renderSection({ templateIds: [TEMPLATE_A_ID], adoptedTemplates: [summary({ id: TEMPLATE_A_ID })] });
    await click(buttonByText("Edit responsibilities"));
    await waitForText("Docs Writer");
    const editor = document.body.querySelector('[role="dialog"]');
    expect(editor?.querySelector('[data-slot="template-responsibility-label"]')).toBeNull();
    expect(editor?.textContent).toContain("Tagline of Docs Writer");
    await click(buttonByText("Add"));
    await click(buttonByText("Save"));
    await waitForCondition(() => templateMocks.updateAgentTemplates.mock.calls.length === 1, "save not called");
    expect(templateMocks.updateAgentTemplates.mock.calls[0]).toEqual([
      "agent-1",
      { expectedVersion: 7, templateIds: [TEMPLATE_A_ID, TEMPLATE_C_ID] },
    ]);
    expect(analyticsMocks.trackEvent).toHaveBeenCalledWith("agent_template_select", {
      surface: "agent_detail",
      action: "add",
      slug: "docs-writer",
    });
  });

  it("reseeds the draft from the server set when reopening an unsaved editor", async () => {
    await renderSection({ templateIds: [TEMPLATE_A_ID], adoptedTemplates: [summary({ id: TEMPLATE_A_ID })] });
    await click(buttonByText("Edit responsibilities"));
    await waitForText("Edit responsibilities");
    await click(buttonByText("Remove"));
    await waitForText("No responsibilities selected.");
    await click(buttonByText("Close"));

    await click(buttonByText("Edit responsibilities"));
    await waitForCondition(() => {
      const dialog = document.body.textContent ?? "";
      return dialog.includes("PR Engineer") && !dialog.includes("No responsibilities selected.");
    }, "draft was not reseeded on reopen");
  });

  it("refreshes the draft and version through a real query subscription after a 409", async () => {
    templateMocks.updateAgentTemplates.mockRejectedValue(
      new ApiError(
        409,
        "Agent templates version mismatch",
        undefined,
        AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES.VERSION_CONFLICT,
      ),
    );
    resourceMocks.getAgentResources
      .mockResolvedValueOnce({
        version: 7,
        templateIds: [TEMPLATE_A_ID],
        adoptedTemplates: [summary({ id: TEMPLATE_A_ID })],
        effective: { version: 7, repos: [], prompts: [], skills: [], mcp: [], unavailable: [] },
        bindings: [],
        availableTeamResources: [],
      })
      .mockResolvedValue({
        version: 9,
        templateIds: [TEMPLATE_C_ID],
        adoptedTemplates: [summary({ id: TEMPLATE_C_ID, name: "Docs Writer" })],
        effective: { version: 9, repos: [], prompts: [], skills: [], mcp: [], unavailable: [] },
        bindings: [],
        availableTeamResources: [],
      });

    function Harness() {
      const resources = useAgentResources("agent-1", { enabled: true });
      if (!resources.data) return null;
      return (
        <ResponsibilitiesSection
          agentUuid="agent-1"
          agentStatus="active"
          canManage
          templateIds={resources.data.templateIds}
          adoptedTemplates={resources.data.adoptedTemplates}
          version={resources.data.version}
        />
      );
    }
    await render(<Harness />);
    await waitForText("PR Engineer");

    await click(buttonByText("Edit responsibilities"));
    await waitForText("Edit responsibilities");
    await click(buttonByText("Remove"));
    await click(buttonByText("Save"));
    await waitForText("refreshed — review and save again.");
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("refreshed — review and save again.");

    // The real subscription refetched after the 409 invalidate.
    expect(resourceMocks.getAgentResources.mock.calls.length).toBeGreaterThanOrEqual(2);
    // The draft reseeded to the new server set: "Docs Writer" is a selected
    // row with Remove, not an addable row with Add.
    await waitForCondition(() => {
      const buttons = [...document.body.querySelectorAll("button")];
      return (
        buttons.some((el) => el.textContent?.trim() === "Remove") &&
        (document.body.textContent ?? "").includes("Docs Writer")
      );
    }, "draft was not reseeded to the new server set");
    expect(document.body.textContent).toContain("refreshed — review and save again.");

    // Editing the refreshed draft and saving again uses the refreshed
    // version fence.
    templateMocks.updateAgentTemplates.mockResolvedValue({
      version: 10,
      templateIds: [],
      adoptedTemplates: [],
      effective: { version: 10, repos: [], prompts: [], skills: [], mcp: [], unavailable: [] },
      bindings: [],
      availableTeamResources: [],
    });
    await click(buttonByText("Remove"));
    await click(buttonByText("Save"));
    await waitForCondition(() => templateMocks.updateAgentTemplates.mock.calls.length === 2, "second save not called");
    expect(templateMocks.updateAgentTemplates.mock.calls[1]).toEqual([
      "agent-1",
      { expectedVersion: 9, templateIds: [] },
    ]);
  });

  it("shows a retryable catalog error while removals still work, without losing the draft", async () => {
    templateMocks.listAgentTemplates.mockRejectedValue(new Error("catalog down"));
    await renderSection({ templateIds: [TEMPLATE_A_ID], adoptedTemplates: [summary({ id: TEMPLATE_A_ID })] });
    await click(buttonByText("Edit responsibilities"));
    await waitForText("Couldn't load the template catalog.");

    // Removals still work against the current set.
    await click(buttonByText("Remove"));
    await waitForText("No responsibilities selected.");

    // Retry re-requests the catalog and preserves the draft.
    templateMocks.listAgentTemplates.mockResolvedValue({ templates: [publicTemplate(TEMPLATE_C_ID, "Docs Writer")] });
    await click(buttonByText("Retry"));
    await waitForCondition(() => templateMocks.listAgentTemplates.mock.calls.length >= 2, "retry did not refetch");
    await waitForText("Docs Writer");
    expect(document.body.textContent).toContain("No responsibilities selected.");
  });

  it("cancel stale reads, writes the authoritative response, and invalidates agent-config", async () => {
    const queryClient = new VanillaQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    let resolveStale!: (value: unknown) => void;
    const staleFetch = queryClient.fetchQuery({
      queryKey: ["agent-resources", "agent-1"],
      queryFn: () =>
        new Promise((resolve) => {
          resolveStale = resolve;
        }),
    });
    staleFetch.catch(() => undefined);

    const response = {
      version: 9,
      templateIds: [],
      adoptedTemplates: [],
      effective: { version: 9, repos: [], prompts: [], skills: [], mcp: [], unavailable: [] },
      bindings: [],
      availableTeamResources: [],
    } satisfies import("@first-tree/shared").AgentResourcesOutput;
    let after = 0;
    const handlers = agentResourcesMutationHandlers(queryClient, "agent-1", {
      onSuccessAfter: () => {
        after += 1;
      },
    });
    await handlers.onSuccess(response);

    expect(queryClient.getQueryData(["agent-resources", "agent-1"])).toBe(response);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["agent-config", "agent-1"] });
    expect(after).toBe(1);

    // The cancelled stale read cannot overwrite the authoritative response.
    resolveStale({
      version: 1,
      templateIds: [],
      adoptedTemplates: [],
      effective: { version: 1, repos: [], prompts: [], skills: [], mcp: [], unavailable: [] },
      bindings: [],
      availableTeamResources: [],
    });
    await staleFetch.catch(() => undefined);
    expect(queryClient.getQueryData(["agent-resources", "agent-1"])).toBe(response);
  });

  it("refreshes and asks for a retry on a version-CAS 409", async () => {
    templateMocks.updateAgentTemplates.mockRejectedValue(
      new ApiError(
        409,
        "Agent templates version mismatch",
        undefined,
        AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES.VERSION_CONFLICT,
      ),
    );
    await renderSection({ templateIds: [TEMPLATE_A_ID], adoptedTemplates: [summary({ id: TEMPLATE_A_ID })] });
    await click(buttonByText("Edit responsibilities"));
    await waitForText("Edit responsibilities");
    await click(buttonByText("Remove"));
    await click(buttonByText("Save"));
    await waitForText("refreshed — review and save again.");
    expect(analyticsMocks.trackEvent).toHaveBeenCalledWith("agent_template_replace_set", { result: "failure" });
  });

  it("keeps the draft and shows the server message on a non-CAS adoption 409", async () => {
    templateMocks.updateAgentTemplates.mockRejectedValue(
      new ApiError(
        409,
        'A Team Skill named "docs-writer" already exists',
        undefined,
        AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES.ADOPTION_CONFLICT,
      ),
    );
    resourceMocks.getAgentResources.mockResolvedValue({
      version: 7,
      templateIds: [TEMPLATE_A_ID],
      adoptedTemplates: [summary({ id: TEMPLATE_A_ID })],
      effective: { version: 7, repos: [], prompts: [], skills: [], mcp: [], unavailable: [] },
      bindings: [],
      availableTeamResources: [],
    });

    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");

    function Harness() {
      const resources = useAgentResources("agent-1", { enabled: true });
      if (!resources.data) return null;
      return (
        <ResponsibilitiesSection
          agentUuid="agent-1"
          agentStatus="active"
          canManage
          templateIds={resources.data.templateIds}
          adoptedTemplates={resources.data.adoptedTemplates}
          version={resources.data.version}
        />
      );
    }
    await render(<Harness />);
    await waitForText("PR Engineer");
    invalidateSpy.mockClear();
    const getsBefore = resourceMocks.getAgentResources.mock.calls.length;

    await click(buttonByText("Edit responsibilities"));
    await waitForText("Edit responsibilities");
    await click(buttonByText("Remove"));
    await waitForText("No responsibilities selected.");
    await click(buttonByText("Save"));
    await waitForText('A Team Skill named "docs-writer" already exists');
    expect(document.body.textContent).not.toContain("refreshed — review and save again.");
    // Draft selection is preserved (empty after Remove).
    expect(document.body.textContent).toContain("No responsibilities selected.");
    // Adoption 409 must not invalidate or refetch through the live subscription.
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(resourceMocks.getAgentResources.mock.calls.length).toBe(getsBefore);
    invalidateSpy.mockRestore();
  });
});
