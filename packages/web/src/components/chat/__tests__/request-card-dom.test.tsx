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
    // bodyShowsTarget defaults false here (the body prop has no @target), so the
    // chip keeps `· @human-1` as the target signal — the metadata-derived
    // fallback for non-normalised bodies.
    expect(container.textContent).toContain("@human-1");
  });

  it("drops the chip's `· @target` when the body already shows the target", async () => {
    const msg = requestMsg();
    const container = await renderDom(
      wrap(
        <RequestCard
          message={msg}
          thread={[msg]}
          viewerAgentId={HUMAN}
          bodyShowsTarget
          body={<div>{BODY}</div>}
          resolveAgentName={(id) => id}
        />,
      ),
    );
    // Target is carried by the body, so the status chip must not repeat it.
    expect(container.textContent).not.toContain("@human-1");
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
    // Collapsed row is a single clickable button (chevron + chip + subject
    // summary); the whole row expands on click — no separate "Expand" word.
    expect(container.textContent).toContain("REQUEST");
    expect(container.textContent).toContain("Rollout");
    // Collapsed hides the body, so the target is shown once in the summary line
    // (the only place it appears in this state).
    expect(container.textContent).toContain("@human-1");
  });

  it("lets an unrelated viewer collapse again after expanding", async () => {
    // Regression: the Collapse button used to be gated on `related`, so an
    // unrelated viewer who clicked the collapsed row to expand had no way back.
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
    // Starts collapsed (unrelated default) — click the row to expand.
    const expandRow = container.querySelector("button");
    if (!expandRow) throw new Error("expected collapsed row button");
    await act(async () => {
      expandRow.click();
    });
    expect(container.textContent).toContain(BODY);
    // A Collapse affordance must exist for this unrelated viewer.
    const collapse = [...container.querySelectorAll("button")].find((b) => b.textContent === "Collapse");
    if (!collapse) throw new Error("expected a Collapse button when expanded");
    await act(async () => {
      collapse.click();
    });
    expect(container.textContent).not.toContain(BODY);
  });

  it("namespaces option radio groups by message id so two open requests don't merge", async () => {
    // Question ids are only request-local (both cards use `q1`). The radio
    // `name` must be namespaced by message id, or the browser groups the two
    // cards' real radio inputs together and selecting in one clears the other.
    const a: Message = { ...requestMsg(), id: "reqA" };
    const b: Message = { ...requestMsg(), id: "reqB" };
    const container = await renderDom(
      wrap(
        <>
          <RequestCard message={a} thread={[a]} viewerAgentId={HUMAN} body={<div />} resolveAgentName={(id) => id} />
          <RequestCard message={b} thread={[b]} viewerAgentId={HUMAN} body={<div />} resolveAgentName={(id) => id} />
        </>,
      ),
    );
    const names = new Set(
      Array.from(container.querySelectorAll("input[type='radio']")).map((el) => el.getAttribute("name")),
    );
    // Two distinct, message-scoped groups — never the bare local id.
    expect(names).toEqual(new Set(["reqA:q1", "reqB:q1"]));
    expect(names.has("q1")).toBe(false);
  });
});
