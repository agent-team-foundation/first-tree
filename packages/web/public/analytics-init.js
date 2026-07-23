/**
 * Analytics boot (GA4 + Microsoft Clarity). Loaded as an external deferred
 * same-origin script from index.html rather than inline blocks: the
 * app-wide CSP forbids inline scripts (`script-src 'self' …`, no
 * `unsafe-inline` — see packages/server/src/security-headers.ts). The
 * third-party loader origins below must stay in sync with the CSP
 * `script-src` allowlist defaults (`FIRST_TREE_CSP_SCRIPT_ORIGINS`).
 *
 * Google Analytics 4 — same property (G-BHG918MZ02) as first-tree.ai, with
 * cross-domain linking so a visitor who goes marketing-site -> cloud is
 * stitched into one user (that's what makes "click_app -> signup"
 * attributable per repo/campaign). send_page_view is off: this is a
 * react-router SPA, so RouteTracker (src/analytics.tsx) reports page_view on
 * every route change — leaving it on would double-count the first screen.
 *
 * PRODUCTION ONLY: the Docker build produces one web dist for every channel,
 * so we gate here on hostname. Without this, dev (127.0.0.1) and staging
 * (dev.cloud.first-tree.ai) would load gtag and write into the shared
 * production property, polluting the attribution dataset. gtag is neither
 * fetched nor configured off the production host. analytics.tsx applies the
 * same host gate before sending, as defense in depth.
 *
 * Microsoft Clarity — session insights for the production Web Console.
 * Hostname-gated for the same reason; staging/local must not write into the
 * production project. The React app root is masked in index.html
 * (`data-clarity-mask`) so customer/workspace text is not uploaded in
 * Clarity recordings by default.
 */
(() => {
  if (window.location.hostname !== "cloud.first-tree.ai") return;

  // GA4
  window.dataLayer = window.dataLayer || [];
  // Keep the official gtag queue shape. gtag.js consumes the function's
  // Arguments object; pushing the rest-parameter Array leaves commands
  // queued without producing GA collect requests in production.
  window.gtag = function gtag() {
    // biome-ignore lint/complexity/noArguments: the official gtag.js queue contract uses Arguments.
    window.dataLayer.push(arguments);
  };
  const gaTag = document.createElement("script");
  gaTag.async = true;
  gaTag.src = "https://www.googletagmanager.com/gtag/js?id=G-BHG918MZ02";
  document.head.appendChild(gaTag);
  window.gtag("js", new Date());
  window.gtag("config", "G-BHG918MZ02", {
    send_page_view: false,
    linker: { domains: ["first-tree.ai", "cloud.first-tree.ai"] },
  });

  // Microsoft Clarity
  window.clarity =
    window.clarity ||
    ((...args) => {
      const queue = window.clarity.q || [];
      window.clarity.q = queue;
      queue.push(args);
    });
  const clarityTag = document.createElement("script");
  clarityTag.async = true;
  clarityTag.src = "https://www.clarity.ms/tag/xj2f9syfng";
  document.head.appendChild(clarityTag);
})();
