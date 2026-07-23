// @vitest-environment happy-dom

import type { GitlabConnectionSummary } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../../components/ui/toast.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const authMock = vi.hoisted(() => ({
  value: { role: "admin" as string | null, organizationId: "org-1" as string | null },
}));
const apiMocks = vi.hoisted(() => ({
  gitlabConnectionsQueryKey: (organizationId: string | null) => ["gitlab-connections", organizationId] as const,
  listGitlabConnections: vi.fn(),
  createGitlabConnection: vi.fn(),
  regenerateGitlabBearer: vi.fn(),
  replaceGitlabConnection: vi.fn(),
  deleteGitlabConnection: vi.fn(),
  listGitlabIdentityLinks: vi.fn(),
  createGitlabIdentityLink: vi.fn(),
  removeGitlabIdentityLink: vi.fn(),
  reconfirmGitlabIdentityLink: vi.fn(),
}));
const memberMocks = vi.hoisted(() => ({ listMembers: vi.fn() }));

vi.mock("../../../auth/auth-context.js", () => ({ useAuth: () => authMock.value }));
vi.mock("../../../api/gitlab-connections.js", () => apiMocks);
vi.mock("../../../api/members.js", () => memberMocks);

function connection(overrides: Partial<GitlabConnectionSummary> = {}): GitlabConnectionSummary {
  return {
    id: "connection-1",
    organizationId: "org-1",
    displayName: "Private GitLab",
    instanceOrigin: "https://gitlab.internal",
    endpointSeen: true,
    stableDeliveryObserved: false,
    reviewerCapability: {
      mode: "unknown",
      lastObservedVersion: null,
      lastSchemaAnomalyAt: null,
      lastSchemaAnomalyCode: null,
    },
    health: {
      readiness: "routing_verified",
      lastValidInboundAt: "2026-07-15T08:00:00.000Z",
      lastSystemHookMergeRequestInboundAt: "2026-07-15T08:00:00.000Z",
      lastProcessingFailureAt: null,
      lastProcessingFailureCode: null,
    },
    createdAt: "2026-07-15T07:00:00.000Z",
    updatedAt: "2026-07-15T08:00:00.000Z",
    ...overrides,
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
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderPage(): Promise<{ container: HTMLElement; root: Root; queryClient: QueryClient }> {
  const { SettingsGitlabPage } = await import("../gitlab.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = client();
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/settings/integrations/gitlab"]}>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <SettingsGitlabPage />
          </ToastProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
  return { container, root, queryClient };
}

async function rerenderPage(rendered: { root: Root; queryClient: QueryClient }): Promise<void> {
  const { SettingsGitlabPage } = await import("../gitlab.js");
  await act(async () => {
    rendered.root.render(
      <MemoryRouter initialEntries={["/settings/integrations/gitlab"]}>
        <QueryClientProvider client={rendered.queryClient}>
          <ToastProvider>
            <SettingsGitlabPage />
          </ToastProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
}

function button(container: ParentNode, text: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    item.textContent?.includes(text),
  );
  if (!match) throw new Error(`Button not found: ${text}`);
  return match;
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  authMock.value = { role: "admin", organizationId: "org-1" };
  apiMocks.listGitlabConnections.mockResolvedValue([]);
  apiMocks.listGitlabIdentityLinks.mockResolvedValue([]);
  memberMocks.listMembers.mockResolvedValue([]);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("SettingsGitlabPage", () => {
  it("keeps the configured admin page to connection and account bindings only", async () => {
    apiMocks.listGitlabConnections.mockResolvedValue([
      connection({
        reviewerCapability: { ...connection().reviewerCapability, mode: "reviewers", lastObservedVersion: "17.11.2" },
      }),
    ]);
    const { container, root } = await renderPage();
    const headings = [...container.querySelectorAll("h2")].map((heading) => heading.textContent);
    expect(headings).toEqual(["Connection", "GitLab account bindings"]);
    expect(container.textContent).toContain("Reviewer compatibility: Modern");
    expect(container.textContent).not.toContain("Automatic actions");
    expect(container.textContent).not.toContain("Skipped targets");
    expect(container.textContent).not.toContain("Suspend");
    await act(async () => root.unmount());
  });

  it("shows the secret exactly once outside query/mutation caches", async () => {
    const webhookUrl = "https://first-tree.example/api/v1/webhooks/gitlab/one-time-secret";
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    apiMocks.createGitlabConnection.mockResolvedValue({ connection: connection(), webhookUrl });
    const rendered = await renderPage();
    expect(rendered.container.textContent).toContain("No GitLab connection");

    await act(async () => button(rendered.container, "Connect GitLab").click());
    const name = document.querySelector<HTMLInputElement>("#gitlab-display-name");
    const origin = document.querySelector<HTMLInputElement>("#gitlab-origin");
    if (!name || !origin) throw new Error("connection form missing");
    await act(async () => {
      name.value = "Private GitLab";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      origin.value = "https://gitlab.internal";
      origin.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(document, "Create").click());
    await flush();
    expect(document.body.textContent).toContain(webhookUrl);
    expect(document.body.textContent).toContain("Finish GitLab System Hook setup");
    expect(document.body.textContent).toContain("Push events");
    expect(document.body.textContent).toContain("Merge request events");
    expect(document.body.textContent).toContain("default payload");
    expect(document.body.textContent).toContain("System Hooks do not deliver Issue or Note events");
    expect(document.body.textContent).not.toContain("project webhook");
    expect(document.querySelector<HTMLAnchorElement>('a[href="https://gitlab.internal/admin/hooks"]')).not.toBeNull();
    expect(
      JSON.stringify(
        rendered.queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain("one-time-secret");
    expect(
      JSON.stringify(
        rendered.queryClient
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state.data),
      ),
    ).not.toContain("one-time-secret");
    await act(async () => button(document, "Copy URL").click());
    await flush();
    expect(writeText).toHaveBeenCalledWith(webhookUrl);
    expect(document.body.textContent).toContain("Copied");
    writeText.mockRejectedValueOnce(new Error("clipboard denied"));
    await act(async () => button(document, "Copied").click());
    await flush();
    expect(document.body.textContent).toContain("Copy failed");
    await act(async () => button(document, "Done").click());
    expect(document.body.textContent).not.toContain(webhookUrl);
    await act(async () => rendered.root.unmount());
  });

  it("clears an open one-time secret when the selected Team changes", async () => {
    const webhookUrl = "https://first-tree.example/api/v1/webhooks/gitlab/team-a-secret";
    apiMocks.createGitlabConnection.mockResolvedValue({ connection: connection(), webhookUrl });
    const rendered = await renderPage();
    await act(async () => button(rendered.container, "Connect GitLab").click());
    const name = document.querySelector<HTMLInputElement>("#gitlab-display-name");
    const origin = document.querySelector<HTMLInputElement>("#gitlab-origin");
    if (!name || !origin) throw new Error("connection form missing");
    await act(async () => {
      name.value = "Private GitLab";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      origin.value = "https://gitlab.internal";
      origin.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(document, "Create").click());
    await flush();
    expect(document.body.textContent).toContain(webhookUrl);

    authMock.value = { role: "admin", organizationId: "org-2" };
    apiMocks.listGitlabConnections.mockResolvedValue([]);
    await rerenderPage(rendered);
    expect(document.body.textContent).not.toContain(webhookUrl);
    await act(async () => rendered.root.unmount());
  });

  it("drops destructive confirmations owned by the previous Team", async () => {
    apiMocks.listGitlabConnections.mockResolvedValue([connection()]);
    const rendered = await renderPage();
    await act(async () => button(rendered.container, "Delete").click());
    expect(document.body.textContent).toContain("Delete GitLab connection?");

    authMock.value = { role: "admin", organizationId: "org-2" };
    apiMocks.listGitlabConnections.mockResolvedValue([connection({ id: "connection-2", organizationId: "org-2" })]);
    await rerenderPage(rendered);
    expect(document.body.textContent).not.toContain("Delete GitLab connection?");
    expect(apiMocks.deleteGitlabConnection).not.toHaveBeenCalled();
    await act(async () => rendered.root.unmount());
  });

  it("discards a one-time secret response that resolves after a Team switch", async () => {
    let resolveCreate!: (value: { connection: GitlabConnectionSummary; webhookUrl: string }) => void;
    apiMocks.createGitlabConnection.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const rendered = await renderPage();
    await act(async () => button(rendered.container, "Connect GitLab").click());
    const name = document.querySelector<HTMLInputElement>("#gitlab-display-name");
    const origin = document.querySelector<HTMLInputElement>("#gitlab-origin");
    if (!name || !origin) throw new Error("connection form missing");
    await act(async () => {
      name.value = "Private GitLab";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      origin.value = "https://gitlab.internal";
      origin.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(document, "Create").click());

    authMock.value = { role: "admin", organizationId: "org-2" };
    apiMocks.listGitlabConnections.mockResolvedValue([]);
    await rerenderPage(rendered);
    await act(async () => {
      resolveCreate({
        connection: connection(),
        webhookUrl: "https://first-tree.example/api/v1/webhooks/gitlab/late-team-a-secret",
      });
    });
    await flush();
    expect(document.body.textContent).not.toContain("late-team-a-secret");
    await act(async () => rendered.root.unmount());
  });

  it("keeps admin management hidden from ordinary members while exposing redacted health", async () => {
    authMock.value = { role: "member", organizationId: "org-member" };
    apiMocks.listGitlabConnections.mockResolvedValue([connection({ organizationId: "org-member" })]);
    const { container, root } = await renderPage();
    expect(container.textContent).toContain("MR routing verified");
    expect(container.textContent).toContain("GitLab version");
    expect(container.textContent).not.toContain("Regenerate URL");
    expect(container.textContent).not.toContain("GitLab account bindings");
    expect(apiMocks.listGitlabIdentityLinks).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("requires a destructive confirmation before regenerating the URL", async () => {
    apiMocks.listGitlabConnections.mockResolvedValue([connection()]);
    apiMocks.regenerateGitlabBearer.mockResolvedValue({
      connection: connection({
        endpointSeen: false,
        stableDeliveryObserved: false,
        health: {
          readiness: "waiting",
          lastValidInboundAt: null,
          lastSystemHookMergeRequestInboundAt: null,
          lastProcessingFailureAt: null,
          lastProcessingFailureCode: null,
        },
      }),
      webhookUrl: "https://first-tree.example/api/v1/webhooks/gitlab/new-secret",
    });
    const { container, root } = await renderPage();
    await act(async () => button(container, "Regenerate URL").click());
    expect(document.body.textContent).toContain("The old URL stops authenticating immediately");
    expect(apiMocks.regenerateGitlabBearer).not.toHaveBeenCalled();
    const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "Regenerate",
    );
    if (!confirm) throw new Error("Regenerate confirmation button missing");
    await act(async () => confirm.click());
    await flush();
    expect(apiMocks.regenerateGitlabBearer).toHaveBeenCalledWith("connection-1");
    expect(document.body.textContent).toContain("new-secret");
    expect(document.body.textContent).toContain("Finish GitLab System Hook setup");
    expect(document.querySelector('[data-testid="gitlab-one-time-setup-status"]')?.textContent).toContain(
      "Waiting for webhook",
    );
    await act(async () => root.unmount());
  });

  it("separates transport receipt, MR routing verification, and processing failure", async () => {
    apiMocks.listGitlabConnections.mockResolvedValue([
      connection({
        instanceOrigin: "https://gitlab.internal:8443",
        health: {
          readiness: "transport_received",
          lastValidInboundAt: "2026-07-15T08:00:00.000Z",
          lastSystemHookMergeRequestInboundAt: null,
          lastProcessingFailureAt: null,
          lastProcessingFailureCode: null,
        },
      }),
    ]);
    const received = await renderPage();
    expect(received.container.textContent).toContain("Webhook received · waiting for MR event");
    expect(received.container.textContent).toContain("Finish MR verification");
    expect(received.container.textContent).toContain("System Hooks do not deliver Issue or Note events");
    expect(received.container.textContent).toContain("Regenerate only if it was not saved");
    expect(
      received.container.querySelector<HTMLAnchorElement>('a[href="https://gitlab.internal:8443/admin/hooks"]'),
    ).not.toBeNull();
    await act(async () => received.root.unmount());

    apiMocks.listGitlabConnections.mockResolvedValue([
      connection({
        health: {
          readiness: "needs_attention",
          lastValidInboundAt: "2026-07-15T08:00:00.000Z",
          lastSystemHookMergeRequestInboundAt: "2026-07-15T08:00:00.000Z",
          lastProcessingFailureAt: "2026-07-15T07:59:00.000Z",
          lastProcessingFailureCode: "malformed_payload",
        },
      }),
    ]);
    const failed = await renderPage();
    expect(failed.container.textContent).toContain("Webhook needs attention");
    expect(failed.container.textContent).toContain("Resolve the processing issue");
    expect(failed.container.textContent).toContain("Latest processing issue: malformed_payload");
    expect(failed.container.querySelector('[data-testid="gitlab-system-hook-recovery"]')?.textContent).not.toContain(
      "malformed_payload",
    );
    await act(async () => failed.root.unmount());

    apiMocks.listGitlabConnections.mockResolvedValue([connection()]);
    const verified = await renderPage();
    expect(verified.container.textContent).toContain("MR routing verified");
    expect(verified.container.querySelector('[data-testid="gitlab-system-hook-recovery"]')).toBeNull();
    await act(async () => verified.root.unmount());
  });

  it("uses organization-scoped query keys when switching Teams", async () => {
    apiMocks.listGitlabConnections.mockResolvedValue([connection()]);
    const first = await renderPage();
    expect(first.queryClient.getQueryCache().find({ queryKey: ["gitlab-connections", "org-1"] })).toBeDefined();
    await act(async () => first.root.unmount());

    authMock.value = { role: "admin", organizationId: "org-2" };
    apiMocks.listGitlabConnections.mockResolvedValue([
      connection({ organizationId: "org-2", displayName: "Other GitLab" }),
    ]);
    const second = await renderPage();
    expect(second.queryClient.getQueryCache().find({ queryKey: ["gitlab-connections", "org-2"] })).toBeDefined();
    expect(second.container.textContent).toContain("Other GitLab");
    await act(async () => second.root.unmount());
  });
});
