import {
  BROWSER_INTEGRATION_REGISTRY,
  GOOGLE_ANALYTICS_MEASUREMENT_ID,
  isBrowserIntegrationActive,
} from "./browser-resource-policy.js";

type GtagFunction = (...args: unknown[]) => void;
type ClarityFunction = ((...args: unknown[]) => void) & { q?: unknown[][] };

export type BrowserBootstrapWindow = {
  location: { hostname: string };
  dataLayer?: unknown[];
  gtag?: GtagFunction;
  clarity?: ClarityFunction;
};

export type BrowserScriptLoader = (documentRef: Document, src: string) => void;

function appendAsyncScript(documentRef: Document, src: string): void {
  const script = documentRef.createElement("script");
  script.async = true;
  script.src = src;
  documentRef.head.appendChild(script);
}

export function bootstrapGoogleAnalytics(
  windowRef: BrowserBootstrapWindow,
  documentRef: Document,
  loadScript: BrowserScriptLoader = appendAsyncScript,
): void {
  const integration = BROWSER_INTEGRATION_REGISTRY.googleAnalytics;
  if (!isBrowserIntegrationActive(integration, windowRef.location.hostname)) return;

  windowRef.dataLayer ??= [];
  windowRef.gtag = function gtag() {
    // biome-ignore lint/complexity/noArguments: the official gtag.js queue contract uses Arguments.
    windowRef.dataLayer?.push(arguments);
  };
  loadScript(documentRef, integration.loaderUrl);
  windowRef.gtag("js", new Date());
  windowRef.gtag("config", GOOGLE_ANALYTICS_MEASUREMENT_ID, {
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    linker: { domains: ["first-tree.ai", "cloud.first-tree.ai"] },
  });
}

export function bootstrapMicrosoftClarity(
  windowRef: BrowserBootstrapWindow,
  documentRef: Document,
  loadScript: BrowserScriptLoader = appendAsyncScript,
): void {
  const integration = BROWSER_INTEGRATION_REGISTRY.microsoftClarity;
  if (!isBrowserIntegrationActive(integration, windowRef.location.hostname)) return;

  if (!windowRef.clarity) {
    const clarity: ClarityFunction = (...args: unknown[]) => {
      clarity.q?.push(args);
    };
    clarity.q = [];
    windowRef.clarity = clarity;
  }
  loadScript(documentRef, integration.loaderUrl);
}

export function bootstrapBrowserIntegrations(
  windowRef: BrowserBootstrapWindow,
  documentRef: Document,
  loadScript: BrowserScriptLoader = appendAsyncScript,
): void {
  bootstrapGoogleAnalytics(windowRef, documentRef, loadScript);
  bootstrapMicrosoftClarity(windowRef, documentRef, loadScript);
}
