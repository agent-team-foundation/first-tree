// @vitest-environment happy-dom

import type { Message } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RequestCard } from "../request-card.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NOW = "2026-06-02T12:00:00.000Z";
const ASKER = "agent-asker";
const HUMAN = "human-1";
const BODY = "BODY-CONTEXT-MARKER full background and decision";

function requestMsg(): Message {
  return {
    id: "req",
    chatId: "c1",
    senderId: ASKER,
    format: "request",
    content: BODY,
    metadata: {
      mentions: [HUMAN],
      request: {
        subject: "Rollout",
        questions: [{ id: "q1", prompt: "Ship 5% or 20%?", kind: "single", options: ["5%", "20%"] }],
      },
    },
    inReplyTo: null,
    source: "api",
    createdAt: NOW,
  };
}

const roots: Root[] = [];
async function renderDom(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(element);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

afterEach(() => {
  for (const r of roots.splice(0)) r.unmount();
  document.body.innerHTML = "";
});

function wrap(node: ReactElement): ReactElement {
  return <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>;
}

describe("RequestCard rendering", () => {
  it("renders the markdown body (not just the answer block) when expanded for the target", async () => {
    const msg = requestMsg();
    const container = await renderDom(
      wrap(
        <RequestCard
          message={msg}
          thread={[msg]}
          viewerAgentId={HUMAN}
          body={<div>{BODY}</div>}
          resolveAgentName={(id) => id}
        />,
      ),
    );
    // The card's half of the contract: when expanded it MUST render the body
    // prop (the long narrative/decision context) alongside the answer block.
    // The actual QA regression was upstream — chat-view passed an empty body
    // for `format=request` (textContent gated to text|markdown); that fix is
    // in chat-view.tsx. This pins the card never silently drops the body.
    expect(container.textContent).toContain(BODY);
    expect(container.textContent).toContain("Ship 5% or 20%?");
    expect(container.textContent).toContain("REQUEST");
  });

  it("collapses for an unrelated viewer — body and answer block hidden", async () => {
    const msg = requestMsg();
    const container = await renderDom(
      wrap(
        <RequestCard
          message={msg}
          thread={[msg]}
          viewerAgentId="someone-else"
          body={<div>{BODY}</div>}
          resolveAgentName={(id) => id}
        />,
      ),
    );
    expect(container.textContent).not.toContain(BODY);
    expect(container.textContent).not.toContain("Ship 5% or 20%?");
    expect(container.textContent).toContain("Expand");
  });
});
