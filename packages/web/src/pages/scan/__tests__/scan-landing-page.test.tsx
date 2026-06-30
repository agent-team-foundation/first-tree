// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { readCampaignHandoff } from "../../quickstart/intent.js";
import { buildScanHandoffHref, ScanLandingPage } from "../scan-landing-page.js";

// Mock the channel hook so each test pins dev / staging / prod / loading.
const channelMock = vi.hoisted(() => ({ value: { channel: "dev" as string | null, settled: true } }));
vi.mock("../../../hooks/use-server-channel.js", () => ({
  useServerChannelState: () => channelMock.value,
}));

const INPUT_LABEL = "GitHub repository URL";

function renderScan(path: string): string {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path="/scan/:campaign" element={<ScanLandingPage />} />
          <Route path="/" element={<div>HOME</div>} />
          <Route path="/quickstart" element={<div>QUICKSTART</div>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("buildScanHandoffHref — landing → quickstart contract", () => {
  it("percent-encodes the repo url so it survives the post-login next round-trip", () => {
    expect(buildScanHandoffHref("production-scan", "https://github.com/acme/backend")).toBe(
      "/quickstart?campaign=production-scan&repo=https%3A%2F%2Fgithub.com%2Facme%2Fbackend",
    );
  });

  it("round-trips: what the landing emits is exactly what quickstart's parser accepts", () => {
    for (const [campaign, url] of [
      ["production-scan", "https://github.com/acme/backend"],
      ["agent-readiness", "https://github.com/octo-org/the.repo"],
    ] as const) {
      const href = buildScanHandoffHref(campaign, url);
      const parsed = readCampaignHandoff({ search: new URL(href, "http://x").search, hash: "" });
      expect(parsed?.campaign).toBe(campaign);
      expect(parsed?.url).toBe(url);
    }
  });
});

describe("ScanLandingPage — dev/staging-only channel gate", () => {
  it("renders the scan form on dev for a known campaign", () => {
    channelMock.value = { channel: "dev", settled: true };
    const markup = renderScan("/scan/production-scan");
    expect(markup).toContain(INPUT_LABEL);
    expect(markup).toContain("Is your repo ready to ship?");
  });

  it("renders on staging too", () => {
    channelMock.value = { channel: "staging", settled: true };
    expect(renderScan("/scan/agent-readiness")).toContain(INPUT_LABEL);
  });

  it("does NOT render the form in prod — the whole funnel is hidden", () => {
    channelMock.value = { channel: "prod", settled: true };
    expect(renderScan("/scan/production-scan")).not.toContain(INPUT_LABEL);
  });

  it("does NOT render the form for an unknown/old server (null channel)", () => {
    channelMock.value = { channel: null, settled: true };
    expect(renderScan("/scan/production-scan")).not.toContain(INPUT_LABEL);
  });

  it("holds a neutral surface (no form) while the channel is still loading", () => {
    channelMock.value = { channel: null, settled: false };
    const markup = renderScan("/scan/production-scan");
    expect(markup).not.toContain(INPUT_LABEL);
    expect(markup).toContain("landing-marketing");
  });

  it("redirects an unknown campaign slug even on dev", () => {
    channelMock.value = { channel: "dev", settled: true };
    expect(renderScan("/scan/bogus-campaign")).not.toContain(INPUT_LABEL);
  });
});
