// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextTreeSetupPreviewPage } from "../context-tree-setup-preview.js";
import {
  contextTreeSetupPreviewModel,
  normalizeContextTreeSetupPreviewQuery,
  setupPreviewBootstrapCommand,
  setupPreviewCode,
} from "../context-tree-setup-preview-model.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-probe">{`${location.pathname}${location.search}`}</output>;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderPreview(entry: string): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/preview/context-tree-setup" element={<ContextTreeSetupPreviewPage />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>,
    );
  });
  await flush();
  return container;
}

async function clickButton(container: ParentNode, label: string): Promise<HTMLButtonElement> {
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(label));
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => {
    button.click();
  });
  await flush();
  return button;
}

beforeEach(() => {
  document.body.innerHTML = "";
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("Context Tree setup preview model", () => {
  it("normalizes role, expiry, and review controls without accepting duplicate state", () => {
    expect(normalizeContextTreeSetupPreviewQuery("?role=member&code=expired&controls=1")).toMatchObject({
      role: "member",
      expired: true,
      controls: true,
      changed: false,
    });
    expect(
      normalizeContextTreeSetupPreviewQuery("?role=member&role=admin&code=expired&code=x&controls=2"),
    ).toMatchObject({
      role: "admin",
      expired: false,
      controls: false,
      search: "role=admin",
      changed: true,
    });
    expect(normalizeContextTreeSetupPreviewQuery("?role=&code=x&controls=")).toMatchObject({
      role: "admin",
      expired: false,
      controls: false,
      search: "role=admin",
      changed: true,
    });
  });

  it("uses a strict preview fixture grammar and the exact two-line staging bootstrap", () => {
    const command = setupPreviewBootstrapCommand(setupPreviewCode("admin"));
    expect(command.split("\n")).toEqual([
      "curl -fsSL https://download.first-tree.ai/releases/staging/install.sh | sh",
      "~/.local/bin/first-tree-staging login FT-PREVIEW-STAGING-ADMIN",
    ]);
    expect(() => setupPreviewBootstrapCommand("FT-X; echo injected")).toThrow(TypeError);
    expect(() => setupPreviewBootstrapCommand("FT-PREVIEW-STAGING-ADMIN\nwhoami")).toThrow(TypeError);
  });

  it("keeps Admin and Member prompts inside their authority boundaries", () => {
    const admin = contextTreeSetupPreviewModel("admin").prompt;
    const member = contextTreeSetupPreviewModel("member").prompt;

    expect(admin).toContain("set up Context Tree for Gandy's team");
    const adminSequence = [
      admin.indexOf("Run tree init to initialize and bind the Context Tree"),
      admin.indexOf("Install or connect the First Tree GitHub App"),
      admin.indexOf("grant it only the exact Context Tree repository"),
      admin.indexOf("Create a reviewer Agent only if automatic Review is enabled"),
      admin.indexOf("Invite the team"),
    ];
    expect(adminSequence.every((position) => position >= 0)).toBe(true);
    expect(adminSequence).toEqual([...adminSequence].sort((a, b) => a - b));
    expect(admin).toContain("base bootstrap and ordinary setup must not create a First Tree Agent");
    expect(member).toContain("Verify an exact read of the Team's shared Context Tree");
    expect(member).not.toMatch(/tree init|GitHub App|repository grant|reviewer Agent/i);
    expect(admin).toContain("fixture code does not authenticate");
    expect(member).toContain("fixture code does not authenticate");
  });
});

describe("Context Tree setup preview handoff", () => {
  it("renders the Admin setup sequence without provider selection", async () => {
    const container = await renderPreview("/preview/context-tree-setup?role=admin");
    const text = container.textContent ?? "";

    expect(text).toContain("Gandy's team is ready");
    expect(text).toContain("initializes and binds the Tree first");
    expect(text).toContain("install or connect the App and grant the exact Tree repository");
    expect(text).toContain("Only automatic Review creates a reviewer Agent");
    expect(text).toContain("The final step is your team invite link");
    expect(text).not.toMatch(/choose (Claude Code|Codex)|select (Claude Code|Codex)/i);
    expect(text).toContain("Computer registration and daemon startup are best effort");
    expect(text).toContain("this bootstrap does not create a First Tree Agent");

    const sequence = [
      text.indexOf("initializes and binds"),
      text.indexOf("install or connect the App"),
      text.indexOf("Only automatic Review"),
      text.indexOf("team invite link"),
    ];
    expect(sequence.every((position) => position >= 0)).toBe(true);
    expect(sequence).toEqual([...sequence].sort((a, b) => a - b));
  });

  it("keeps Member setup personal and requires an exact Tree read", async () => {
    const container = await renderPreview("/preview/context-tree-setup?role=member");
    const text = container.textContent ?? "";

    expect(text).toContain("You joined Gandy's team");
    expect(text).toContain("Verify an exact read of the Team's shared Context Tree");
    expect(text).toContain("This handoff only installs, signs in, and verifies your exact Tree read");
    expect(text).not.toContain("initializes and binds the Tree first");
    expect(text).not.toContain("Only automatic Review creates a reviewer Agent");
    expect(text).not.toContain("team invite link");
    expect(text).not.toMatch(/tree init|GitHub App|repo(?:sitory)? grant|reviewer Agent/i);
  });

  it("keeps both terminal fallbacks at exactly two synchronized lines", async () => {
    for (const role of ["admin", "member"] as const) {
      const container = await renderPreview(`/preview/context-tree-setup?role=${role}`);
      await clickButton(container, "Prefer a terminal command?");
      const command = container.querySelector('[data-testid="terminal-bootstrap-command"]')?.textContent ?? "";
      const prompt = container.querySelector('[data-testid="setup-prompt"]')?.textContent ?? "";

      expect(command.split("\n")).toHaveLength(2);
      expect(prompt).toContain(command);
      expect(command).toContain(`FT-PREVIEW-STAGING-${role.toUpperCase()}`);
    }
  });

  it("replaces an expired fixture everywhere, cleans the URL, and restores focus", async () => {
    const container = await renderPreview("/preview/context-tree-setup?role=admin&code=expired");
    const oldCode = "FT-PREVIEW-STAGING-ADMIN";

    expect(container.textContent).toContain(oldCode);
    const copyButton = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Fixture expired"),
    );
    expect(copyButton?.disabled).toBe(true);

    await clickButton(container, "Generate new fixture");
    expect(document.activeElement?.textContent).toContain("Copy setup prompt");
    await clickButton(container, "Prefer a terminal command?");

    const newCode = "FT-PREVIEW-STAGING-1-ADMIN";
    const setupPrompt = container.querySelector('[data-testid="setup-prompt"]')?.textContent ?? "";
    const agentPrompt = container.querySelector('[data-testid="agent-prompt"]')?.textContent ?? "";
    const terminal = container.querySelector('[data-testid="terminal-bootstrap-command"]')?.textContent ?? "";
    expect(setupPrompt).toContain(newCode);
    expect(agentPrompt).toContain(newCode);
    expect(terminal).toContain(newCode);
    expect(container.textContent).not.toContain(oldCode);
    expect(container.querySelector('[data-testid="location-probe"]')?.textContent).toBe(
      "/preview/context-tree-setup?role=admin",
    );
  });

  it("keeps expiry scoped to each role when only Member regenerates", async () => {
    const container = await renderPreview("/preview/context-tree-setup?role=admin&code=expired&controls=1");
    const activeAdmin = container.querySelector('a[aria-current="page"]') as HTMLAnchorElement | null;
    expect(activeAdmin?.href).toContain("code=expired");

    await act(async () => activeAdmin?.click());
    await flush();
    expect(container.querySelector('[data-testid="location-probe"]')?.textContent).toContain("code=expired");
    expect(
      [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Fixture expired"))
        ?.disabled,
    ).toBe(true);

    const memberLink = [...container.querySelectorAll("a")].find((link) => link.textContent === "Member");
    await act(async () => memberLink?.click());
    await flush();
    expect(container.querySelector('[data-context-tree-setup-preview="member"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="location-probe"]')?.textContent).toContain("code=expired");
    expect(
      [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Fixture expired"))
        ?.disabled,
    ).toBe(true);

    await clickButton(container, "Generate new fixture");
    expect(container.textContent).toContain("FT-PREVIEW-STAGING-1-MEMBER");
    expect(container.querySelector('[data-testid="location-probe"]')?.textContent).not.toContain("code=expired");

    const adminLink = [...container.querySelectorAll("a")].find((link) => link.textContent === "Admin");
    await act(async () => adminLink?.click());
    await flush();
    expect(container.querySelector('[data-context-tree-setup-preview="admin"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="location-probe"]')?.textContent).toContain("code=expired");
    expect(container.textContent).toContain("FT-PREVIEW-STAGING-ADMIN");
    expect(container.textContent).not.toContain("FT-PREVIEW-STAGING-1-ADMIN");
    expect(
      [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Fixture expired"))
        ?.disabled,
    ).toBe(true);
  });

  it("preserves regenerated fixture identity without stealing focus on role return", async () => {
    const container = await renderPreview("/preview/context-tree-setup?role=admin&code=expired&controls=1");

    await clickButton(container, "Generate new fixture");
    expect(container.textContent).toContain("FT-PREVIEW-STAGING-1-ADMIN");

    const memberLink = [...container.querySelectorAll("a")].find((link) => link.textContent === "Member");
    await act(async () => memberLink?.click());
    await flush();
    expect(container.querySelector('[data-context-tree-setup-preview="member"]')).not.toBeNull();
    expect(container.textContent).toContain("FT-PREVIEW-STAGING-MEMBER");
    expect(container.textContent).not.toContain("FT-PREVIEW-STAGING-1-MEMBER");

    const adminLink = [...container.querySelectorAll("a")].find(
      (link) => link.textContent === "Admin",
    ) as HTMLAnchorElement | undefined;
    adminLink?.focus();
    await act(async () => adminLink?.click());
    await flush();
    expect(container.querySelector('[data-context-tree-setup-preview="admin"]')).not.toBeNull();
    expect(container.textContent).toContain("FT-PREVIEW-STAGING-1-ADMIN");
    expect(container.textContent).not.toContain("FT-PREVIEW-STAGING-ADMIN");
    expect(document.activeElement).toBe(adminLink);
  });

  it("announces clipboard rejection and focuses the opened fallback", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    const container = await renderPreview("/preview/context-tree-setup?role=member");

    await clickButton(container, "Copy connection prompt");

    expect(container.textContent).toContain("Copy failed. The terminal fallback is open for manual copy.");
    const fallback = container.querySelector('[data-testid="terminal-bootstrap-command"]');
    expect(fallback?.textContent?.split("\n")).toHaveLength(2);
    expect(document.activeElement).toBe(fallback);
  });

  it("canonicalizes invalid direct links and exposes role controls only on request", async () => {
    const container = await renderPreview(
      "/preview/context-tree-setup?role=member&role=admin&code=expired&code=x&controls=2",
    );

    expect(container.querySelector('[data-context-tree-setup-preview="admin"]')).not.toBeNull();
    expect(container.querySelector('nav[aria-label="Context Tree setup preview role"]')).toBeNull();
    expect(container.querySelector('[data-testid="location-probe"]')?.textContent).toBe(
      "/preview/context-tree-setup?role=admin",
    );

    const controlled = await renderPreview("/preview/context-tree-setup?role=member&controls=1");
    expect(controlled.querySelector('nav[aria-label="Context Tree setup preview role"]')).not.toBeNull();
  });
});
