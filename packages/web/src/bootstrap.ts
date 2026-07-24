import { config as configureZod } from "zod";
import { PROD_HOST } from "./analytics-config.js";

type GtagWindow = Window & {
  dataLayer?: IArguments[];
  gtag?: (...args: unknown[]) => void;
  clarity?: ClarityFunction;
};

type ClarityFunction = ((...args: unknown[]) => void) & { q?: unknown[][] };

// Zod's object parser otherwise probes `new Function` during module startup.
// Jitless mode uses its interpreter path and keeps the enforced CSP violation-free.
configureZod({ jitless: true });

function appendAsyncScript(src: string): void {
  const tag = document.createElement("script");
  tag.async = true;
  tag.src = src;
  document.head.appendChild(tag);
}

function applyStoredTheme(): void {
  const storedTheme = localStorage.getItem("theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  if (storedTheme === "dark" || (!storedTheme && prefersDark)) {
    document.documentElement.classList.add("dark");
  }
}

function bootstrapProductionAnalytics(): void {
  const analyticsWindow = window as GtagWindow;
  analyticsWindow.dataLayer ??= [];
  const gtag = function gtag(..._args: unknown[]): void {
    // biome-ignore lint/complexity/noArguments: the official gtag.js queue contract uses Arguments.
    analyticsWindow.dataLayer?.push(arguments);
  };
  analyticsWindow.gtag = gtag;
  appendAsyncScript("https://www.googletagmanager.com/gtag/js?id=G-BHG918MZ02");
  gtag("js", new Date());
  gtag("config", "G-BHG918MZ02", {
    send_page_view: false,
    linker: { domains: ["first-tree.ai", PROD_HOST] },
  });

  const clarityQueue: ClarityFunction = (...args: unknown[]) => {
    const queue = clarityQueue.q ?? [];
    clarityQueue.q = queue;
    queue.push(args);
  };
  analyticsWindow.clarity ??= clarityQueue;
  appendAsyncScript("https://www.clarity.ms/tag/xj2f9syfng");
}

applyStoredTheme();
if (window.location.hostname === PROD_HOST) bootstrapProductionAnalytics();
