// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import {
  type BrowserBootstrapWindow,
  bootstrapBrowserIntegrations,
  bootstrapGoogleAnalytics,
} from "../browser-bootstrap.js";
import {
  GOOGLE_ANALYTICS_LOADER_URL,
  GOOGLE_ANALYTICS_MEASUREMENT_ID,
  MICROSOFT_CLARITY_LOADER_URL,
} from "../browser-resource-policy.js";

function queuedCommand(value: unknown): unknown[] {
  if (typeof value !== "object" || value === null || !("length" in value)) return [];
  return Array.from(value as ArrayLike<unknown>);
}

describe("external analytics bootstrap", () => {
  it("does not initialize a vendor away from the production hostname", () => {
    const browserWindow: BrowserBootstrapWindow = { location: { hostname: "dev.cloud.first-tree.ai" } };
    const loadedScripts: string[] = [];

    bootstrapBrowserIntegrations(browserWindow, document, (_documentRef, src) => {
      loadedScripts.push(src);
    });

    expect(browserWindow.dataLayer).toBeUndefined();
    expect(browserWindow.clarity).toBeUndefined();
    expect(loadedScripts).toEqual([]);
  });

  it("loads exact registry URLs and narrows GA advertising capabilities", () => {
    const browserWindow: BrowserBootstrapWindow = { location: { hostname: "cloud.first-tree.ai" } };
    const loadedScripts: string[] = [];

    bootstrapBrowserIntegrations(browserWindow, document, (_documentRef, src) => {
      loadedScripts.push(src);
    });

    expect(loadedScripts).toEqual([GOOGLE_ANALYTICS_LOADER_URL, MICROSOFT_CLARITY_LOADER_URL]);

    const commands = browserWindow.dataLayer?.map(queuedCommand) ?? [];
    expect(commands[0]?.[0]).toBe("js");
    expect(commands[1]).toEqual([
      "config",
      GOOGLE_ANALYTICS_MEASUREMENT_ID,
      {
        send_page_view: false,
        allow_google_signals: false,
        allow_ad_personalization_signals: false,
        linker: { domains: ["first-tree.ai", "cloud.first-tree.ai"] },
      },
    ]);
    browserWindow.clarity?.("event", "security-contract-test");
    expect(browserWindow.clarity?.q).toEqual([["event", "security-contract-test"]]);
  });

  it("queues the official Arguments object rather than a rest-parameter array", () => {
    const browserWindow: BrowserBootstrapWindow = { location: { hostname: "cloud.first-tree.ai" } };
    bootstrapGoogleAnalytics(browserWindow, document, () => undefined);

    const queued = browserWindow.dataLayer?.[0];
    expect(Array.isArray(queued)).toBe(false);
    expect(queuedCommand(queued)[0]).toBe("js");
  });
});
