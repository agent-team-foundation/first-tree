// @vitest-environment happy-dom

import type { SkillDescriptor } from "@first-tree/shared";
import { act, type ReactElement, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlashCommandPopover, type SlashSystemCommand, useSlashCommand } from "../slash-command-autocomplete.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type PickedEvent = {
  text: string;
  cursor: number;
  kind: "system" | "skill";
  label: string;
};

const systemCommands: SlashSystemCommand[] = [
  { kind: "system", name: "help", description: "Show help" },
  { kind: "system", name: "clear", description: "Clear chat" },
];

const skills: SkillDescriptor[] = [
  {
    name: "review",
    namespace: "code",
    source: "user",
    description:
      "Review the current branch for correctness, missing tests, regressions, maintainability, and release risk.",
  },
  {
    name: "ship",
    source: "user",
    description: "Prepare the change for release.",
  },
];

function labelForPicked(kind: "system" | "skill", text: string): string {
  if (kind === "system") return "system";
  return text.trim();
}

function Harness({
  initialValue = "/",
  disabled = false,
  withAnchor = true,
  withSkills = true,
  onPicked,
}: {
  initialValue?: string;
  disabled?: boolean;
  withAnchor?: boolean;
  withSkills?: boolean;
  onPicked: (event: PickedEvent) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [cursor, setCursor] = useState(initialValue.length);
  const [ready, setReady] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => setReady(true), []);
  const slash = useSlashCommand({
    value,
    cursor,
    systemCommands,
    agentSkills: withSkills ? { agentId: "agent-1", agentDisplayName: "Nova", skills } : null,
    mentionedAgent: withSkills ? { agentId: "agent-1", displayName: "Nova" } : null,
    disabled,
    onSelect: (insert, picked) => {
      setValue(insert.text);
      setCursor(insert.cursor);
      onPicked({
        ...insert,
        label: picked.kind === "system" ? picked.name : labelForPicked(insert.kind, insert.text),
      });
    },
  });

  return (
    <div>
      <textarea
        ref={withAnchor ? textareaRef : undefined}
        aria-label="Composer"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setCursor(event.target.selectionStart ?? event.target.value.length);
        }}
        onKeyDown={(event) => slash.handleKey(event)}
      />
      <button type="button" onClick={() => slash.dismiss()}>
        Dismiss
      </button>
      <button
        type="button"
        onClick={() => {
          if (slash.results[1]) slash.pick(slash.results[1]);
        }}
      >
        Pick second
      </button>
      <div data-testid="state">
        {slash.trigger ? "open" : "closed"}:{slash.highlightIndex}:{slash.results.length}:
        {slash.mentionedAgent?.displayName ?? "none"}:{value}:{cursor}
      </div>
      {ready && (
        <SlashCommandPopover
          trigger={slash.trigger}
          results={slash.results}
          highlightIndex={slash.highlightIndex}
          mentionedAgent={slash.mentionedAgent}
          onPick={slash.pick}
          anchorRef={textareaRef}
        />
      )}
    </div>
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderDom(element: ReactElement): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  await flush();
  return { container, root };
}

async function keyDown(element: Element, key: string): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  await flush();
}

async function mouseDown(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to receive mousedown");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

beforeEach(() => {
  document.body.innerHTML = "";
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("slash command DOM behavior", () => {
  it("drives keyboard highlight, selection, escape dismissal, and system command clearing", async () => {
    const picked: PickedEvent[] = [];
    const { container, root } = await renderDom(<Harness onPicked={(event) => picked.push(event)} />);
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Expected textarea");

    expect(container.textContent).toContain("open:0:4:Nova");
    expect(container.textContent).toContain("System");
    expect(container.textContent).toContain("@Nova");
    expect(container.textContent).toContain("/code:review");
    expect(container.querySelector('[role="option"]')?.getAttribute("aria-selected")).toBe("true");

    await keyDown(textarea, "ArrowDown");
    expect(container.textContent).toContain("open:1:4:Nova");

    await keyDown(textarea, "ArrowUp");
    expect(container.textContent).toContain("open:0:4:Nova");

    await keyDown(textarea, "Tab");
    expect(picked.at(-1)).toEqual({ text: "", cursor: 0, kind: "system", label: "clear" });
    expect(container.textContent).toContain("closed:0:0:Nova::0");

    await act(async () => root.unmount());

    const dismissed = await renderDom(<Harness onPicked={(event) => picked.push(event)} />);
    const dismissedTextarea = dismissed.container.querySelector<HTMLTextAreaElement>("textarea");
    if (!dismissedTextarea) throw new Error("Expected textarea");
    await keyDown(dismissedTextarea, "Escape");
    expect(dismissed.container.textContent).toContain("closed:0:0:Nova:/:1");
    await act(async () => dismissed.root.unmount());
  });

  it("picks skill commands by mouse and public pick helper, then closes when disabled or anchorless", async () => {
    const picked: PickedEvent[] = [];
    const { container, root } = await renderDom(
      <Harness initialValue="/co" onPicked={(event) => picked.push(event)} />,
    );

    const option = [...container.querySelectorAll('[role="option"]')].find((el) =>
      el.textContent?.includes("/code:review"),
    );
    expect(option?.getAttribute("title")).toContain("release risk");
    expect(option?.textContent).toContain("Review the current branch");
    await mouseDown(option ?? null);
    expect(picked.at(-1)).toEqual({
      text: "/code:review ",
      cursor: "/code:review ".length,
      kind: "skill",
      label: "/code:review",
    });

    await act(async () => root.unmount());

    const publicPick = await renderDom(<Harness initialValue="/" onPicked={(event) => picked.push(event)} />);
    await click(
      [...publicPick.container.querySelectorAll("button")].find((button) => button.textContent === "Pick second") ??
        null,
    );
    expect(picked.at(-1)).toEqual({ text: "", cursor: 0, kind: "system", label: "help" });
    await act(async () => publicPick.root.unmount());

    const disabled = await renderDom(<Harness disabled onPicked={(event) => picked.push(event)} />);
    expect(disabled.container.textContent).toContain("closed:0:0:Nova");
    await act(async () => disabled.root.unmount());

    const anchorless = await renderDom(<Harness withAnchor={false} onPicked={(event) => picked.push(event)} />);
    expect(anchorless.container.textContent).toContain("open:0:4:Nova");
    expect(anchorless.container.querySelector('[role="listbox"]')).toBeNull();
    await act(async () => anchorless.root.unmount());

    const systemOnly = await renderDom(<Harness withSkills={false} onPicked={(event) => picked.push(event)} />);
    expect(systemOnly.container.textContent).toContain("open:0:2:none");
    expect(systemOnly.container.textContent).not.toContain("Skills");
    await act(async () => systemOnly.root.unmount());
  });
});
