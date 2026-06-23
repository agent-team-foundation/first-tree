// @vitest-environment happy-dom

import type { CapabilityEntry } from "@first-tree/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeStateLine } from "../cards/shared/runtime-state-line.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(element: React.ReactElement): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
  });
  return container;
}

beforeEach(() => {
  document.body.innerHTML = "";
  root = null;
  container = null;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  document.body.innerHTML = "";
});

describe("RuntimeStateLine", () => {
  it("shows when Codex is running through the system CLI fallback", async () => {
    const entry: CapabilityEntry = {
      available: true,
      state: "ok",
      authenticated: true,
      sdkVersion: "0.139.0",
      authMethod: "auth_json",
      runtimeSource: "path",
      runtimePath: "/usr/local/bin/codex",
      detectedAt: "2026-06-12T12:00:00.000Z",
    };

    const dom = await render(<RuntimeStateLine provider="codex" entry={entry} os="darwin" />);

    expect(dom.textContent).toContain("Codex v0.139.0");
    expect(dom.textContent).toContain("system CLI fallback");
  });

  it("drops the manual login hint for an in-product provider (codex), even via the system CLI fallback", async () => {
    // codex auth is obtained in-product via the adjacent Connect button (which
    // drives `codex login` on the resolved binary, bundled OR system PATH), so
    // the state line must not also print a manual "Run `codex login`" command —
    // that would contradict the no-separate-CLI onboarding.
    const entry: CapabilityEntry = {
      available: true,
      state: "unauthenticated",
      authenticated: false,
      sdkVersion: "0.139.0",
      authMethod: "none",
      runtimeSource: "path",
      runtimePath: "/usr/local/bin/codex",
      detectedAt: "2026-06-12T12:00:00.000Z",
    };

    const dom = await render(<RuntimeStateLine provider="codex" entry={entry} os="darwin" />);

    expect(dom.textContent).toContain("system CLI fallback");
    expect(dom.textContent).toContain("needs login");
    expect(dom.textContent).not.toContain("codex login");
  });

  it("gives a concrete install command when a runtime is missing", async () => {
    const entry: CapabilityEntry = {
      available: false,
      state: "missing",
      authenticated: false,
      sdkVersion: null,
      authMethod: "none",
      error: "@anthropic-ai/claude-agent-sdk bundled Claude binary could not be located",
      detectedAt: "2026-06-12T12:00:00.000Z",
    };

    const dom = await render(<RuntimeStateLine provider="claude-code" entry={entry} os="darwin" />);

    expect(dom.textContent).toContain("Claude Code");
    expect(dom.textContent).toContain("npm install -g @anthropic-ai/claude-code");
    // The bare "not installed" label is replaced by an actionable hint.
    expect(dom.textContent).not.toContain("not installed");
  });

  it("tells a Claude-Code machine that only lacks tmux to install just tmux", async () => {
    // The `claude` CLI resolved fine; only tmux is absent, so the probe's
    // resolve reason names tmux alone. The hint must not tell the user to
    // reinstall the Claude CLI they already have.
    const entry: CapabilityEntry = {
      available: false,
      state: "missing",
      authenticated: false,
      sdkVersion: "2.1.84",
      authMethod: "none",
      error: "tmux not found",
      detectedAt: "2026-06-12T12:00:00.000Z",
    };

    const dom = await render(<RuntimeStateLine provider="claude-code-tui" entry={entry} os="darwin" />);

    expect(dom.textContent).toContain("Claude Code CLI");
    // macOS → Homebrew command, not a generic "install tmux".
    expect(dom.textContent).toContain("brew install tmux");
    expect(dom.textContent).not.toContain("npm install");
  });

  it("keys the tmux install command to the host OS (Linux → apt)", async () => {
    const entry: CapabilityEntry = {
      available: false,
      state: "missing",
      authenticated: false,
      sdkVersion: "2.1.84",
      authMethod: "none",
      error: "tmux not found",
      detectedAt: "2026-06-12T12:00:00.000Z",
    };

    const dom = await render(<RuntimeStateLine provider="claude-code-tui" entry={entry} os="linux" />);

    expect(dom.textContent).toContain("sudo apt install tmux");
    expect(dom.textContent).not.toContain("brew");
  });

  it("names tmux generically when the OS is unknown, with no guessed package manager", async () => {
    const entry: CapabilityEntry = {
      available: false,
      state: "missing",
      authenticated: false,
      sdkVersion: "2.1.84",
      authMethod: "none",
      error: "tmux not found",
      detectedAt: "2026-06-12T12:00:00.000Z",
    };

    const dom = await render(<RuntimeStateLine provider="claude-code-tui" entry={entry} os={null} />);

    expect(dom.textContent).toContain("tmux (>= 3.0)");
    expect(dom.textContent).toContain("package manager");
    // No OS evidence → don't show a Linux/macOS command.
    expect(dom.textContent).not.toContain("apt");
    expect(dom.textContent).not.toContain("brew");
  });

  it("names both requirements when the TUI runtime is missing claude and tmux", async () => {
    const entry: CapabilityEntry = {
      available: false,
      state: "missing",
      authenticated: false,
      sdkVersion: null,
      authMethod: "none",
      error: "`claude` not found (checked CLAUDE_CODE_EXECUTABLE, PATH, …); tmux not found",
      detectedAt: "2026-06-12T12:00:00.000Z",
    };

    const dom = await render(<RuntimeStateLine provider="claude-code-tui" entry={entry} os="darwin" />);

    expect(dom.textContent).toContain("@anthropic-ai/claude-code");
    expect(dom.textContent).toContain("tmux");
  });
});
