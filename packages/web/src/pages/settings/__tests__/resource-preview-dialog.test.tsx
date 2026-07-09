// @vitest-environment happy-dom

import type { ResourceRow } from "@first-tree/shared";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResourcePreviewDialog } from "../resource-preview-dialog.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function resource(overrides: Partial<ResourceRow> = {}): ResourceRow {
  return {
    id: "resource-1",
    organizationId: "org-1",
    type: "prompt",
    scope: "team",
    ownerAgentId: null,
    name: "Review prompt",
    repoCanonicalKey: null,
    defaultEnabled: "recommended",
    status: "active",
    payload: {},
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: "2026-07-04T10:00:00.000Z",
    updatedAt: "2026-07-04T10:00:00.000Z",
    ...overrides,
  };
}

async function render(ui: ReactElement): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(ui));
  return { container, root };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ResourcePreviewDialog", () => {
  it("renders repo and mcp metadata without a body region", async () => {
    const onClose = vi.fn();
    const repo = await render(
      <ResourcePreviewDialog
        resource={resource({
          type: "repo",
          name: "Runtime repo",
          defaultEnabled: "available",
          payload: { url: "https://github.com/acme/runtime", defaultBranch: "main" },
        })}
        onClose={onClose}
      />,
    );

    expect(document.body.textContent).toContain("Runtime repo");
    expect(document.body.textContent).toContain("Opt-in");
    expect(document.body.textContent).toContain("Repository URL");
    expect(document.body.textContent).toContain("https://github.com/acme/runtime");
    expect(document.body.textContent).toContain("main");
    expect(document.body.textContent).not.toContain("Body");
    await act(async () => repo.root.unmount());

    const mcp = await render(
      <ResourcePreviewDialog
        resource={resource({
          type: "mcp",
          name: "filesystem",
          defaultEnabled: null,
          payload: {
            name: "fs-server",
            transport: "stdio",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem"],
            url: "http://localhost/mcp",
          },
        })}
        onClose={onClose}
      />,
    );

    expect(document.body.textContent).toContain("filesystem");
    expect(document.body.textContent).toContain("fs-server");
    expect(document.body.textContent).toContain("stdio");
    expect(document.body.textContent).toContain("npx");
    expect(document.body.textContent).toContain("@modelcontextprotocol/server-filesystem");
    expect(document.body.textContent).toContain("http://localhost/mcp");
    await act(async () => mcp.root.unmount());
  });

  it("renders skill and prompt bodies, metadata, empty bodies, and close callbacks", async () => {
    const onClose = vi.fn();
    const skill = await render(
      <ResourcePreviewDialog
        resource={resource({
          type: "skill",
          name: "Planning skill",
          payload: {
            name: "planning",
            namespace: "ops",
            description: "Reusable planning procedure",
            metadata: { owner: "team", retries: 2 },
            body: "# Plan\n\nUse this procedure.",
          },
        })}
        onClose={onClose}
      />,
    );

    expect(document.body.textContent).toContain("Planning skill");
    expect(document.body.textContent).toContain("Content");
    expect(document.body.textContent).toContain("planning");
    expect(document.body.textContent).toContain("ops");
    expect(document.body.textContent).toContain("Reusable planning procedure");
    expect(document.body.textContent).toContain("owner: team");
    expect(document.body.textContent).toContain("retries: 2");
    expect(document.body.textContent).toContain("Use this procedure.");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await act(async () => undefined);
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => skill.root.unmount());

    const prompt = await render(
      <ResourcePreviewDialog
        resource={resource({
          type: "prompt",
          name: "Empty prompt",
          defaultEnabled: null,
          payload: { description: "", body: "   " },
        })}
        onClose={onClose}
      />,
    );

    expect(document.body.textContent).toContain("Empty prompt");
    expect(document.body.textContent).toContain("Body");
    expect(document.body.textContent).toContain("Empty.");
    await act(async () => prompt.root.unmount());
  });
});
