/*
  index.html bootstrap — theme, GA4 and Microsoft Clarity.

  These used to be three inline <script> blocks in index.html. They live in
  this external same-origin file so the Content-Security-Policy can enforce
  `script-src` without 'unsafe-inline' (issue 1541). Vite copies public/
  assets through verbatim, so dev and build serve the identical file.

  Order matters: the theme snippet runs first — this file is loaded as a
  classic blocking script in <head>, so the `dark` class lands on <html>
  before first paint and the page cannot flash the wrong theme.
*/

(() => {
  const t = localStorage.getItem("theme");
  const m = window.matchMedia("(prefers-color-scheme: dark)").matches;
  if (t === "dark" || (!t && m)) document.documentElement.classList.add("dark");
})();

/*
  Google Analytics 4 — same property (G-BHG918MZ02) as first-tree.ai, with
  cross-domain linking so a visitor who goes marketing-site -> cloud is
  stitched into one user (that's what makes "click_app -> signup"
  attributable per repo/campaign). send_page_view is off: this is a
  react-router SPA, so RouteTracker (src/analytics.tsx) reports page_view on
  every route change — leaving it on would double-count the first screen.

  PRODUCTION ONLY: the Docker build produces one web dist for every channel,
  so we gate here on hostname. Without this, dev (127.0.0.1) and staging
  (dev.cloud.first-tree.ai) would load gtag and write into the shared
  production property, polluting the attribution dataset. gtag is neither
  fetched nor configured off the production host. analytics.tsx applies the
  same host gate before sending, as defense in depth.
*/
(() => {
  if (window.location.hostname !== "cloud.first-tree.ai") return;
  window.dataLayer = window.dataLayer || [];
  // Keep the official gtag queue shape. gtag.js consumes the function's
  // Arguments object; pushing the rest-parameter Array leaves commands
  // queued without producing GA collect requests in production.
  window.gtag = function gtag() {
    // biome-ignore lint/complexity/noArguments: the official gtag.js queue contract uses Arguments.
    window.dataLayer.push(arguments);
  };
  const tag = document.createElement("script");
  tag.async = true;
  tag.src = "https://www.googletagmanager.com/gtag/js?id=G-BHG918MZ02";
  document.head.appendChild(tag);
  window.gtag("js", new Date());
  window.gtag("config", "G-BHG918MZ02", {
    send_page_view: false,
    linker: { domains: ["first-tree.ai", "cloud.first-tree.ai"] },
  });
})();

/*
  Microsoft Clarity — session insights for the production Web Console.
  Like GA4, this is hostname-gated because the Docker build ships one dist
  across channels; staging/local must not write into the production project.
  The React app root is masked in index.html (data-clarity-mask) so
  customer/workspace text is not uploaded in Clarity recordings by default.
*/
(() => {
  if (window.location.hostname !== "cloud.first-tree.ai") return;
  window.clarity =
    window.clarity ||
    ((...args) => {
      const queue = window.clarity.q || [];
      window.clarity.q = queue;
      queue.push(args);
    });
  const tag = document.createElement("script");
  tag.async = true;
  tag.src = "https://www.clarity.ms/tag/xj2f9syfng";
  document.head.appendChild(tag);
})();
