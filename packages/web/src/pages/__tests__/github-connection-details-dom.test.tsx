// @vitest-environment happy-dom

import type { GithubAppInstallationOutput } from "@first-tree/shared";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GithubConnectionDetails } from "../github-connection-details.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function installation(overrides: Partial<GithubAppInstallationOutput> = {}): GithubAppInstallationOutput {
  return {
    installationId: 123,
    accountType: "Organization",
    accountLogin: "acme",
    accountGithubId: 456,
    permissions: { issues: "write", pull_requests: "write", metadata: "read", contents: "write" },
    events: ["issues", "issue_comment", "pull_request", "push", "member"],
    suspended: false,
    manageUrl: "https://github.com/organizations/acme/settings/installations/123",
    createdAt: "2026-08-03T09:12:00.000Z",
    updatedAt: "2026-08-06T16:41:00.000Z",
    ...overrides,
  };
}

async function renderDom(element: ReactElement): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return { container, root };
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(text)) ?? null;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("GithubConnectionDetails", () => {
  it("keeps the detail behind a collapsed disclosure", async () => {
    const { container, root } = await renderDom(<GithubConnectionDetails data={installation()} />);

    expect(buttonByText(container, "Connection details")?.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("Required by First Tree");
    expect(container.textContent).not.toContain("131952074");

    await act(async () => root.unmount());
  });

  it("answers 'is this installation good enough' before listing raw grants", async () => {
    const { container, root } = await renderDom(<GithubConnectionDetails data={installation()} defaultOpen />);

    // Required set is named in prose and marked satisfied.
    expect(container.textContent).toContain("Required by First Tree");
    expect(container.textContent).toContain("Issues");
    expect(container.textContent).toContain("Pull requests");
    // Everything else is secondary, not mixed into the requirement list.
    expect(container.textContent).toContain("Also granted");
    expect(container.textContent).toContain("Contents");
    // Nothing is blocked, so no GitHub-side call to action appears.
    expect(container.querySelector('a[href*="settings/installations"]')).toBeNull();

    await act(async () => root.unmount());
  });

  it("marks a shortfall, says what it costs, and points at the fix", async () => {
    const data = installation({ permissions: { issues: "write", pull_requests: "read", metadata: "read" } });
    const { container, root } = await renderDom(<GithubConnectionDetails data={data} defaultOpen />);

    expect(container.textContent).toContain("Agents can't post replies on pull requests.");
    const grant = container.querySelector<HTMLAnchorElement>(`a[href="${data.manageUrl}"]`);
    expect(grant?.textContent).toContain("Grant on GitHub");

    await act(async () => root.unmount());
  });

  it("surfaces the shortfall on the collapsed toggle so it isn't hidden", async () => {
    const data = installation({ permissions: { issues: "write", pull_requests: "read" } });
    const { container, root } = await renderDom(<GithubConnectionDetails data={data} />);

    expect(container.textContent).toContain("Pull requests access is missing");

    await act(async () => root.unmount());
  });

  it("counts multiple shortfalls rather than naming one of them", async () => {
    const { container, root } = await renderDom(<GithubConnectionDetails data={installation({ permissions: {} })} />);

    expect(container.textContent).toContain("2 required permissions are missing");

    await act(async () => root.unmount());
  });

  it("treats a higher granted level as satisfying the requirement", async () => {
    const data = installation({ permissions: { issues: "admin", pull_requests: "write" } });
    const { container, root } = await renderDom(<GithubConnectionDetails data={data} defaultOpen />);

    expect(container.textContent).not.toContain("Agents can't post replies on issues.");

    await act(async () => root.unmount());
  });

  it("withholds the GitHub call to action from members who can't act on it", async () => {
    const data = installation({ permissions: { issues: "write", pull_requests: "read" } });
    const { container, root } = await renderDom(<GithubConnectionDetails data={data} readOnly defaultOpen />);

    // Members still read the same diagnosis...
    expect(container.textContent).toContain("Agents can't post replies on pull requests.");
    // ...without a button they have no standing to use.
    expect(container.querySelector(`a[href="${data.manageUrl}"]`)).toBeNull();

    await act(async () => root.unmount());
  });

  it("names the events it consumes and calls out the ones it drops", async () => {
    const { container, root } = await renderDom(<GithubConnectionDetails data={installation()} defaultOpen />);

    expect(container.textContent).toContain("Issue comments");
    // `push` / `member` are subscribed but never normalized into activity —
    // saying so is the answer when a webhook produced nothing.
    expect(container.textContent).toContain("Subscribed but unused: push, member");

    await act(async () => root.unmount());
  });

  it("renders the installation id and both timestamps the API already returns", async () => {
    const { container, root } = await renderDom(<GithubConnectionDetails data={installation()} defaultOpen />);

    expect(container.textContent).toContain("123");
    expect(container.textContent).toContain("Connected");
    expect(container.textContent).toContain("Last updated");
    expect(container.textContent).toContain(
      new Date("2026-08-03T09:12:00.000Z").toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
    );
    expect(container.querySelector('[aria-label="Copy installation id"]')).not.toBeNull();

    await act(async () => root.unmount());
  });

  it("degrades gracefully on permission and event names it has never seen", async () => {
    const data = installation({
      permissions: { issues: "write", pull_requests: "write", dependabot_secrets: "read" },
      events: ["issues", "some_future_event"],
    });
    const { container, root } = await renderDom(<GithubConnectionDetails data={data} defaultOpen />);

    expect(container.textContent).toContain("Dependabot secrets");
    expect(container.textContent).toContain("Subscribed but unused: some_future_event");

    await act(async () => root.unmount());
  });
});
