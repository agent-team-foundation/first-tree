/**
 * Visual regression skeleton — scaffolding for cross-platform typography + token QA.
 *
 * Prerequisites (not installed in this repo yet):
 *   pnpm --filter @first-tree/web add -D @playwright/test
 *   pnpm exec playwright install chromium webkit firefox
 *
 * Then wire into package.json:
 *   "test:visual": "playwright test --config=tests/playwright.config.ts"
 *
 * Philosophy: each scenario captures a focused component or page on both Mac
 * and Windows viewports, at 1x + 1.25x DPR, in both light and dark themes.
 * The diff threshold is intentionally tight (0.1%) so that a 1px layout shift
 * or a font-weight regression fails the gate.
 *
 * Baselines live next to this file under __screenshots__/ and are committed.
 * Update after intentional visual changes with: playwright test --update-snapshots
 */

// Once @playwright/test is installed, uncomment:
//   import { expect, test } from "@playwright/test";
//   import type { Page } from "@playwright/test";
// Everything below references the types as if already imported; tsc skips
// this file (not in tsconfig.include), and Biome sees it as plain TS.

export type Viewport = { name: string; width: number; height: number; deviceScaleFactor: number };

// Macbook Pro 14" (2021) at ~1512 logical px wide, DPR 2.
export const MAC_VIEWPORT: Viewport = { name: "mac", width: 1512, height: 982, deviceScaleFactor: 2 };
// Windows 11 laptop at 1920×1080 with the default 125% DPI scale → 1536 logical wide.
export const WIN_125_VIEWPORT: Viewport = { name: "win-125", width: 1536, height: 864, deviceScaleFactor: 1.25 };
// Windows 11 laptop at 1920×1080 with 150% scale → 1280 logical. Triggers most DPI bugs.
export const WIN_150_VIEWPORT: Viewport = { name: "win-150", width: 1280, height: 720, deviceScaleFactor: 1.5 };

export const VIEWPORTS: readonly Viewport[] = [MAC_VIEWPORT, WIN_125_VIEWPORT, WIN_150_VIEWPORT];
export const THEMES = ["light", "dark"] as const;

// Scenario matrix: each entry captures one surface area. Paths are relative to
// the dev server URL. Set `waitFor` to a selector whose presence means the
// surface has rendered past initial data fetch.
export const SCENARIOS: readonly {
  id: string;
  route: string;
  waitFor: string;
  note: string;
}[] = [
  { id: "workspace-empty", route: "/", waitFor: "[data-testid=roster]", note: "Roster + empty chat pane" },
  {
    id: "workspace-chat",
    route: "/?a=SEED_AGENT_ID",
    waitFor: "[data-testid=chat-view]",
    note: "Chat thread with message + Send input",
  },
  { id: "agents-list", route: "/agents", waitFor: "[data-testid=agents-table]", note: "DenseTable heavy" },
  { id: "agent-detail", route: "/agents/SEED_AGENT_ID", waitFor: "#ad-identity", note: "All Panels + Danger Zone" },
  { id: "computers", route: "/clients", waitFor: "[data-testid=clients-table]", note: "ConnectStrip + DenseTable" },
  {
    id: "members",
    route: "/settings/members",
    waitFor: "[data-testid=members-table]",
    note: "Badge + avatar initials",
  },
  {
    id: "org-settings",
    route: "/settings/org",
    waitFor: "[data-testid=org-settings-form]",
    note: "Form rows with soft callouts",
  },
  {
    id: "new-agent-dialog",
    route: "/agents?dialog=new",
    waitFor: "[role=dialog]",
    note: "Dialog + overlay scrim",
  },
];

// Pseudocode for the shape the actual loadScenario implementation should take
// once @playwright/test is installed. Kept as a commented reference so the
// test file is executable-by-Biome but not by Playwright yet.
//
// export async function loadScenario(
//   page: Page,
//   scenario: (typeof SCENARIOS)[number],
//   theme: "light" | "dark",
// ) {
//   await page.emulateMedia({ colorScheme: theme });
//   await page.goto(scenario.route);
//   await page.waitForSelector(scenario.waitFor, { state: "visible" });
//   // Wait for web fonts so we don't capture a FOUT frame:
//   await page.evaluate(() => document.fonts.ready);
//   // Pause animations (thinking-bar, ring-pulse) so diffs don't flap:
//   await page.addStyleTag({
//     content: "* { animation: none !important; transition: none !important; }",
//   });
// }

/*
test.describe("visual regression · typography / tokens", () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      for (const scenario of SCENARIOS) {
        test(`${scenario.id} · ${viewport.name} · ${theme}`, async ({ page, browser }) => {
          const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            deviceScaleFactor: viewport.deviceScaleFactor,
            // Emulate Windows Segoe UI when on a win-* viewport by disabling
            // Inter via CSS var override — forces the fallback chain to resolve
            // as it would on a real Win machine that hasn't finished loading
            // the self-hosted Inter yet.
            ...(viewport.name.startsWith("win") && {
              extraHTTPHeaders: { "x-ftreehub-fallback-fonts": "win" },
            }),
          });
          const probePage = await context.newPage();
          await loadScenario(probePage, scenario, theme);
          await expect(probePage).toHaveScreenshot(`${scenario.id}-${viewport.name}-${theme}.png`, {
            maxDiffPixelRatio: 0.001, // 0.1% tolerance
            animations: "disabled",
          });
          await context.close();
        });
      }
    }
  }
});
*/

// ---------------------------------------------------------------------------
// Component-level scenarios.
// These hit a Storybook-free "preview harness" mounted at /__visual/:component
// (to be added as a dev-only route) so we diff individual atoms without the
// noise of real page data. Skeletons only — uncomment once the harness exists.
// ---------------------------------------------------------------------------

export const COMPONENT_SCENARIOS = [
  "Typography", // one screen showing all 6 text-* tokens stacked
  "Button", // primary / secondary / destructive / outline / ghost / link × 4 sizes
  "Input", // default / focused / disabled / error
  "Card", // Card + CardHeader/Title/Description/Content/Footer
  "Table", // DenseTable 10-row sample + Table fallback
  "DialogOverlay", // overlay scrim color pick
  "StateChip", // all 5 states (idle/working/blocked/error/offline)
  "Callouts", // error-soft / warn-soft / success-soft triples
] as const;
