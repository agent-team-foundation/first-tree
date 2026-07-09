// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";
import { SourceIcon } from "../source-icon.js";

describe("SourceIcon", () => {
  let h: DomHarness;
  beforeEach(() => {
    h = createDomHarness();
  });
  afterEach(() => h.cleanup());

  it("renders source and github entity glyphs with emphasize color", () => {
    h.render(
      <>
        <SourceIcon source="manual" />
        <SourceIcon source="agent" emphasize size={20} />
        <SourceIcon source="github" entityType={null} />
        <SourceIcon source="github" entityType="pull_request" />
        <SourceIcon source="github" entityType="issue" />
        <SourceIcon source="github" entityType="discussion" />
        <SourceIcon source="github" entityType="commit" />
        <SourceIcon source={undefined} />
      </>,
    );

    const labels = Array.from(h.container.querySelectorAll("[role='img']")).map((el) => el.getAttribute("aria-label"));
    expect(labels).toEqual([
      "Human-created chat",
      "Agent-created task",
      "GitHub",
      "Pull request",
      "Issue",
      "Discussion",
      "Commit",
      "Conversation",
    ]);
  });
});
