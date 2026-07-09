// @vitest-environment happy-dom

import type { ResourceRow } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";
import { ResourcePreviewDialog } from "../resource-preview-dialog.js";

function base(overrides: Partial<ResourceRow> & Pick<ResourceRow, "type" | "name" | "payload">): ResourceRow {
  return {
    id: "res-1",
    organizationId: "org-1",
    scope: "organization",
    ownerAgentId: null,
    repoCanonicalKey: null,
    defaultEnabled: "available",
    status: "active",
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("ResourcePreviewDialog", () => {
  let h: DomHarness;
  beforeEach(() => {
    h = createDomHarness();
  });
  afterEach(() => h.cleanup());

  it("renders repo fields", async () => {
    const onClose = vi.fn();
    h.render(
      <ResourcePreviewDialog
        onClose={onClose}
        resource={base({
          type: "repo",
          name: "Web",
          defaultEnabled: "recommended",
          payload: { url: "https://github.com/acme/web", defaultBranch: "main" },
        })}
      />,
    );
    await h.flush();
    expect(document.body.textContent).toContain("Web");
    expect(document.body.textContent).toContain("https://github.com/acme/web");
    expect(document.body.textContent).toContain("main");
  });

  it("renders mcp transport/command/args/url", async () => {
    h.render(
      <ResourcePreviewDialog
        onClose={() => undefined}
        resource={base({
          type: "mcp",
          name: "fs",
          payload: {
            name: "filesystem",
            transport: "stdio",
            command: "npx",
            args: ["-y", "server"],
            url: "https://mcp.example",
          },
        })}
      />,
    );
    await h.flush();
    expect(document.body.textContent).toContain("filesystem");
    expect(document.body.textContent).toContain("stdio");
    expect(document.body.textContent).toContain("npx");
    expect(document.body.textContent).toContain("-y");
    expect(document.body.textContent).toContain("https://mcp.example");
  });

  it("renders skill/prompt bodies and empty body fallback", async () => {
    h.render(
      <ResourcePreviewDialog
        onClose={() => undefined}
        resource={base({
          type: "skill",
          name: "Review",
          payload: {
            name: "review-skill",
            namespace: "team",
            description: "Review PRs",
            body: "# Review\n\nDo the review.",
            metadata: { tier: "core", n: 1 },
          },
        })}
      />,
    );
    await h.flush();
    expect(document.body.textContent).toContain("review-skill");
    expect(document.body.textContent).toContain("team");
    expect(document.body.textContent).toContain("Review PRs");
    expect(document.body.textContent).toContain("tier: core");
    expect(document.body.textContent).toContain("Do the review.");

    h.cleanup();
    h = createDomHarness();
    h.render(
      <ResourcePreviewDialog
        onClose={() => undefined}
        resource={base({
          type: "prompt",
          name: "Empty prompt",
          payload: { body: "   " },
        })}
      />,
    );
    await h.flush();
    expect(document.body.textContent).toContain("Empty.");
  });

  it("renders repo without url/branch defaults", async () => {
    h.render(
      <ResourcePreviewDialog
        onClose={() => undefined}
        resource={base({
          type: "repo",
          name: "Bare",
          payload: {},
        })}
      />,
    );
    await h.flush();
    expect(document.body.textContent).toContain("Repository default");
  });
});
