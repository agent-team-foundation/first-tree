// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SourceIcon } from "../source-icon.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function render(ui: ReactElement): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(ui));
  return { container, root };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("SourceIcon", () => {
  it("uses source-level labels and the defensive missing-source fallback", async () => {
    const { container, root } = await render(
      <div>
        <SourceIcon source="manual" />
        <SourceIcon source="agent" emphasize size={20} />
        <SourceIcon source={undefined} />
      </div>,
    );

    expect(container.querySelector('[aria-label="Human-created chat"]')).not.toBeNull();
    const agent = container.querySelector<SVGElement>('[aria-label="Agent-created task"]');
    expect(agent).not.toBeNull();
    expect(agent?.getAttribute("width")).toBe("20");
    expect(agent?.style.color).toBe("var(--fg)");
    expect(container.querySelector('[aria-label="Conversation"]')).not.toBeNull();
    await act(async () => root.unmount());
  });

  it("uses GitHub entity labels and falls back for null or unknown entity types", async () => {
    const { container, root } = await render(
      <div>
        <SourceIcon source="github" entityType="pull_request" />
        <SourceIcon source="github" entityType="issue" />
        <SourceIcon source="github" entityType="discussion" />
        <SourceIcon source="github" entityType="commit" />
        <SourceIcon source="github" entityType={null} />
        <SourceIcon source="github" entityType={"constructor" as never} />
      </div>,
    );

    for (const label of ["Pull request", "Issue", "Discussion", "Commit"]) {
      expect(container.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
    }
    expect(container.querySelectorAll('[aria-label="GitHub"]')).toHaveLength(2);
    await act(async () => root.unmount());
  });
});
