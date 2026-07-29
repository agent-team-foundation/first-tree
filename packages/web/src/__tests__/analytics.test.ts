import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sanitizePath } from "../analytics.js";
import { initializeProductionAnalytics } from "../bootstrap.js";

const indexHtml = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const bootstrapSource = readFileSync(new URL("../bootstrap.ts", import.meta.url), "utf8");

type TestScript = {
  async?: boolean;
  src?: string;
};

type TestAnalyticsWindow = {
  clarity?: ((...args: unknown[]) => void) & { q?: unknown[][] };
  dataLayer?: IArguments[];
  gtag?: (...args: unknown[]) => void;
  location: { hostname: string };
};

function stubBrowser(hostname: string): {
  readonly appendedScripts: TestScript[];
  readonly browserWindow: TestAnalyticsWindow;
} {
  const appendedScripts: TestScript[] = [];
  const browserWindow: TestAnalyticsWindow = { location: { hostname } };
  vi.stubGlobal("window", browserWindow);
  vi.stubGlobal("document", {
    querySelector: () => null,
    createElement: () => ({}),
    head: {
      appendChild: (script: TestScript) => {
        appendedScripts.push(script);
      },
    },
  });
  return { appendedScripts, browserWindow };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("production gtag bootstrap", () => {
  it("queues the official Arguments object so gtag.js processes commands", () => {
    expect(bootstrapSource).toContain("dataLayer?.push(arguments)");
    expect(bootstrapSource).not.toContain("dataLayer?.push(args)");
  });

  it("loads only the enumerated analytics scripts on the production host", () => {
    const { appendedScripts, browserWindow } = stubBrowser("cloud.first-tree.ai");

    initializeProductionAnalytics();

    expect(appendedScripts.map((script) => script.src)).toEqual([
      "https://www.googletagmanager.com/gtag/js?id=G-BHG918MZ02",
      "https://www.clarity.ms/tag/xj2f9syfng",
    ]);
    expect(browserWindow.dataLayer).toHaveLength(2);
    expect(Array.from(browserWindow.dataLayer?.[0] ?? [])).toEqual(["js", expect.any(Date)]);
    expect(Array.from(browserWindow.dataLayer?.[1] ?? [])).toEqual([
      "config",
      "G-BHG918MZ02",
      {
        send_page_view: false,
        linker: { domains: ["first-tree.ai", "cloud.first-tree.ai"] },
      },
    ]);
  });

  it("does not load analytics scripts outside the production host", () => {
    const { appendedScripts, browserWindow } = stubBrowser("dev.cloud.first-tree.ai");

    initializeProductionAnalytics();

    expect(appendedScripts).toEqual([]);
    expect(browserWindow.dataLayer).toBeUndefined();
    expect(browserWindow.gtag).toBeUndefined();
    expect(browserWindow.clarity).toBeUndefined();
  });

  it("keeps the SPA shell free of inline scripts", () => {
    expect(indexHtml).toContain('<script type="module" src="/src/bootstrap.ts"></script>');
    expect(indexHtml).toContain('<script type="module" src="/src/main.tsx"></script>');
    expect(indexHtml).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/u);
  });
});

describe("sanitizePath", () => {
  it("templates invite tokens so the code never reaches GA", () => {
    expect(sanitizePath("/invite/abc123secret")).toBe("/invite/[token]");
    expect(sanitizePath("/invite/another-long-token")).toBe("/invite/[token]");
  });

  it("collapses the OAuth complete route to a fixed path", () => {
    // The token lives in the hash, but template the path too as defense in depth.
    expect(sanitizePath("/auth/github/complete")).toBe("/auth/github/complete");
  });

  it("passes through ordinary routes unchanged", () => {
    expect(sanitizePath("/")).toBe("/");
    expect(sanitizePath("/agents")).toBe("/agents");
    expect(sanitizePath("/settings/team")).toBe("/settings/team");
  });

  it("does not leak a token even when the invite path has extra segments", () => {
    expect(sanitizePath("/invite/tok/extra")).toBe("/invite/[token]");
  });
});
