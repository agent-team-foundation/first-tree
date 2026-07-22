// Analytics bootstrap: Google Analytics 4 + Microsoft Clarity.
//
// External file, not an inline script: the enforced Content-Security-Policy
// ships without script-src 'unsafe-inline'. The origins below must also be
// present in the server's FIRST_TREE_CSP_ANALYTICS_ORIGINS on the production
// deployment, otherwise the CSP blocks these tags.
//
// Google Analytics 4 — same property (G-BHG918MZ02) as first-tree.ai, with
// cross-domain linking so a visitor who goes marketing-site -> cloud is
// stitched into one user (that's what makes "click_app -> signup"
// attributable per repo/campaign). send_page_view is off: this is a
// react-router SPA, so RouteTracker (src/analytics.tsx) reports page_view on
// every route change — leaving it on would double-count the first screen.
//
// Microsoft Clarity — session insights for the production Web Console. The
// React app root is masked (data-clarity-mask on #root) so customer/workspace
// text is not uploaded in Clarity recordings by default.
//
// PRODUCTION ONLY: the Docker build produces one web dist for every channel,
// so both tags are gated on hostname. Without this, dev (127.0.0.1) and
// staging (dev.cloud.first-tree.ai) would load gtag/Clarity and write into
// the shared production datasets, polluting attribution. Neither script is
// fetched nor configured off the production host; analytics.tsx applies the
// same host gate before sending, as defense in depth.
(() => {
  if (window.location.hostname !== "cloud.first-tree.ai") return;

  // Keep the official gtag queue shape. gtag.js consumes the function's
  // Arguments object; pushing the rest-parameter Array leaves commands
  // queued without producing GA collect requests in production.
  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() {
    // biome-ignore lint/complexity/noArguments: the official gtag.js queue contract uses Arguments.
    window.dataLayer.push(arguments);
  };
  const gtagScript = document.createElement("script");
  gtagScript.async = true;
  gtagScript.src = "https://www.googletagmanager.com/gtag/js?id=G-BHG918MZ02";
  document.head.appendChild(gtagScript);
  window.gtag("js", new Date());
  window.gtag("config", "G-BHG918MZ02", {
    send_page_view: false,
    linker: { domains: ["first-tree.ai", "cloud.first-tree.ai"] },
  });

  window.clarity =
    window.clarity ||
    ((...args) => {
      const queue = window.clarity.q || [];
      window.clarity.q = queue;
      queue.push(args);
    });
  const clarityScript = document.createElement("script");
  clarityScript.async = true;
  clarityScript.src = "https://www.clarity.ms/tag/xj2f9syfng";
  document.head.appendChild(clarityScript);
})();
