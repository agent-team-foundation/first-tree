/**
 * Browser bootstrap that must run before React mounts.
 *
 * Keep this in an external module instead of an inline `<script>` in
 * `index.html`: the server can then enforce a CSP with `script-src 'self'`
 * and never needs a reusable nonce in the static SPA shell.
 */

const PROD_HOST = "cloud.first-tree.ai";
const GA_MEASUREMENT_ID = "G-BHG918MZ02";
const CLARITY_PROJECT_ID = "xj2f9syfng";

type GtagArgs = [command: "js", value: Date] | [command: "config", targetId: string, config?: Record<string, unknown>];

type ClarityStub = {
  (...args: unknown[]): void;
  q?: unknown[][];
};

type AnalyticsWindow = Window & {
  dataLayer?: IArguments[];
  gtag?: (...args: GtagArgs) => void;
  clarity?: ClarityStub;
};

/**
 * Apply the saved theme before the application paints its first React frame.
 * Storage and media-query access can fail in privacy/sandboxed contexts, so a
 * failure falls back to the document's default light theme.
 */
export function applyInitialTheme(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  let savedTheme: string | null = null;
  try {
    savedTheme = window.localStorage.getItem("theme");
  } catch {
    // Private/sandboxed storage is optional; system preference still applies.
  }

  let prefersDark = false;
  try {
    prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  } catch {
    // Some embedded browsers expose matchMedia but throw for unsupported media.
  }

  document.documentElement.classList.toggle("dark", savedTheme === "dark" || (!savedTheme && prefersDark));
}

/** Load one external analytics SDK without creating an inline script block. */
function loadAnalyticsScript(src: string): void {
  if (document.querySelector(`script[src="${src}"]`)) return;
  const tag = document.createElement("script");
  tag.async = true;
  tag.src = src;
  document.head.appendChild(tag);
}

/**
 * Queue the production-only analytics SDKs. The hostname gate is retained
 * from the previous bootstrap so staging and local builds cannot pollute the
 * shared production properties.
 */
export function initializeProductionAnalytics(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.location.hostname !== PROD_HOST) return;

  const analyticsWindow = window as AnalyticsWindow;
  analyticsWindow.dataLayer = analyticsWindow.dataLayer ?? [];
  analyticsWindow.gtag =
    analyticsWindow.gtag ??
    function gtag(): void {
      // The official gtag loader consumes the Arguments object, not a spread
      // array. Keep this queue shape stable for the SDK and its tests.
      // biome-ignore lint/complexity/noArguments: the official gtag.js queue contract uses Arguments.
      analyticsWindow.dataLayer?.push(arguments);
    };

  loadAnalyticsScript(`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`);
  analyticsWindow.gtag("js", new Date());
  analyticsWindow.gtag("config", GA_MEASUREMENT_ID, {
    send_page_view: false,
    linker: { domains: ["first-tree.ai", "cloud.first-tree.ai"] },
  });

  analyticsWindow.clarity =
    analyticsWindow.clarity ??
    (() => {
      const queued: ClarityStub = (...args: unknown[]): void => {
        queued.q ??= [];
        queued.q.push(args);
      };
      return queued;
    })();
  loadAnalyticsScript(`https://www.clarity.ms/tag/${CLARITY_PROJECT_ID}`);
}

export function bootstrapBrowser(): void {
  applyInitialTheme();
  initializeProductionAnalytics();
}

bootstrapBrowser();
