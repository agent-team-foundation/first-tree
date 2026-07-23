// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSetupRows, type SetupFacts, SetupOverview } from "../setup.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../../../hooks/use-viewport.js", () => ({
  useWorkspaceViewport: () => "xl",
}));

function facts(overrides: Partial<SetupFacts> = {}): SetupFacts {
  return {
    role: "admin",
    teamName: "Acme",
    hasUsableAgent: true,
    hasPersonalAgent: true,
    computers: {
      state: "ready",
      value: { connected: 1, saved: 1, connectedHostname: "acme-mac" },
    },
    repositories: { state: "ready", value: 2 },
    contextTree: {
      state: "ready",
      value: {
        bound: true,
        repo: "https://github.com/acme/context-tree.git",
        branch: "main",
        availability: "active",
      },
    },
    github: {
      state: "ready",
      value: { accountLogin: "acme", accountType: "Organization", suspended: false },
    },
    gitlab: {
      state: "ready",
      value: { displayName: "Engineering", instanceOrigin: "https://gitlab.acme.test" },
    },
    ...overrides,
  };
}

async function renderSetup(input: SetupFacts) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <SetupOverview facts={input} rows={buildSetupRows(input)} />
      </MemoryRouter>,
    );
  });
  return { host, root };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Settings Setup overview", () => {
  it("renders the six approved facts in order without completion or resource rows", async () => {
    const view = await renderSetup(facts());
    const titles = [...view.host.querySelectorAll("section > div:first-child .text-body")].map(
      (node) => node.textContent,
    );

    expect(titles).toEqual([
      "Work access",
      "Your computer",
      "Your agent",
      "Code repositories",
      "Context Tree",
      "GitHub / GitLab",
    ]);
    expect(view.host.textContent).not.toContain("Resources");
    expect(view.host.textContent).not.toContain("Integrations");
    expect(view.host.textContent).not.toContain("Team agents");
    expect(view.host.textContent).not.toContain("%");
    expect(view.host.textContent).not.toContain("Onboarding completed");
    expect(view.host.querySelector("h1")).toBeNull();
    expect(view.host.querySelector("[data-setup-lead]")?.textContent).toBe("See what's ready and what you can set up.");
    expect(view.host.querySelector("[data-setup-context]")?.textContent).toBe("Acme · Admin");
    expect(view.host.textContent).not.toContain("set up for Acme");
    expect(view.host.textContent).not.toContain("Your access and configuration");
    expect(view.host.textContent).not.toContain("finish setup");
    expect(view.host.textContent).not.toContain("complete setup");

    await act(async () => view.root.unmount());
  });

  it("treats a team agent as work access while personal computer and agent stay optional", async () => {
    const input = facts({
      role: "member",
      hasUsableAgent: true,
      hasPersonalAgent: false,
      computers: {
        state: "ready",
        value: { connected: 0, saved: 0, connectedHostname: null },
      },
      repositories: { state: "ready", value: 0 },
      contextTree: {
        state: "ready",
        value: { bound: false, repo: null, branch: null, availability: "unavailable" },
      },
      github: { state: "ready", value: null },
      gitlab: { state: "ready", value: null },
    });
    const view = await renderSetup(input);

    expect(view.host.textContent).toContain("Can work now");
    expect(view.host.textContent).toContain("A team agent is available");
    expect(view.host.textContent).toContain("Optional while a team agent is available");
    expect(view.host.textContent).not.toContain("Action required");
    const computerRow = [...view.host.querySelectorAll("section")].find((section) =>
      section.textContent?.includes("Your computer"),
    );
    expect(computerRow?.textContent).toContain("Optional while a team agent is available");

    const actionByTitle = new Map(
      [...view.host.querySelectorAll("section")].map((section) => [
        section.querySelector(".text-body")?.textContent,
        section.querySelector("a")?.textContent,
      ]),
    );
    expect(actionByTitle.get("Code repositories")).toBe("View");
    expect(actionByTitle.get("Context Tree")).toBe("View");
    expect(actionByTitle.get("GitHub / GitLab")).toBeUndefined();
    expect(view.host.textContent).not.toContain("Manage");
    expect(view.host.querySelector("button[disabled]")).toBeNull();
    expect(view.host.querySelectorAll('[role="status"][aria-live="polite"]')).toHaveLength(6);

    await act(async () => view.root.unmount());
  });

  it("uses actual availability instead of treating a Context Tree binding as healthy", () => {
    const input = facts({
      contextTree: {
        state: "ready",
        value: {
          bound: true,
          repo: "git@github.com:acme/context-tree.git",
          branch: "main",
          availability: "unavailable",
        },
      },
    });
    const row = buildSetupRows(input).find((candidate) => candidate.key === "context-tree");

    expect(row?.status.label).toBe("Bound · unavailable");
    expect(row?.status.positive).not.toBe(true);
    expect(row?.status.detail).toBe("acme/context-tree · main branch");
  });

  it("keeps optional provider gaps neutral and gives only admins a connect action", () => {
    const rows = buildSetupRows(
      facts({
        github: { state: "ready", value: null },
        gitlab: { state: "ready", value: null },
      }),
    );
    const providers = rows.find((row) => row.key === "providers");

    expect(providers?.status).toEqual({ label: "Not connected", detail: "Optional" });
    expect(providers?.action).toEqual({ label: "Connect", to: "/settings/integrations" });
  });

  it("summarizes one or two real provider connections in a single row", () => {
    const githubOnly = buildSetupRows(facts({ gitlab: { state: "ready", value: null } })).find(
      (row) => row.key === "providers",
    );
    const both = buildSetupRows(facts()).find((row) => row.key === "providers");

    expect(githubOnly?.status.label).toBe("GitHub · acme");
    expect(githubOnly?.action).toEqual({ label: "Manage", to: "/settings/integrations/github" });
    expect(both?.status.label).toBe("GitHub + GitLab");
    expect(both?.status.detail).toBe("acme · Engineering");
  });

  it("does not offer Connect until both provider queries prove there is no connection", () => {
    const loading = buildSetupRows(
      facts({
        github: { state: "loading" },
        gitlab: { state: "ready", value: null },
      }),
    ).find((row) => row.key === "providers");
    const failed = buildSetupRows(
      facts({
        github: { state: "error" },
        gitlab: { state: "ready", value: null },
      }),
    ).find((row) => row.key === "providers");

    expect(loading?.status.label).toBe("Checking…");
    expect(loading?.action).toBeUndefined();
    expect(failed?.status.label).toBe("Unavailable");
    expect(failed?.action).toBeUndefined();
  });

  it("does not claim a team agent makes the computer optional when work access is personal", () => {
    const computer = buildSetupRows(
      facts({
        hasUsableAgent: true,
        hasPersonalAgent: true,
        computers: {
          state: "ready",
          value: { connected: 0, saved: 0, connectedHostname: null },
        },
      }),
    ).find((row) => row.key === "computer");

    expect(computer?.status.detail).toBe("No computer connected");
  });
});
