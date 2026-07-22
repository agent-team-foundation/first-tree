/**
 * Security bootstrap: this module intentionally has no static imports.
 *
 * OAuth/continuation values arrive in the fragment so they avoid HTTP
 * Referer and server logs, but an eager App/Sentry import would still let the
 * complete analytics/error graph observe `location.href` before React's old
 * cleanup effect ran. Copy the raw fragment into this tiny module's closure,
 * erase it from browser history, and only then evaluate the application.
 */
const CALLBACK_PATHS = new Set(["/auth/complete", "/auth/github/complete"]);
let bootstrapFragment =
  CALLBACK_PATHS.has(window.location.pathname) && window.location.hash ? window.location.hash : null;

if (bootstrapFragment !== null) {
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}

void import("./main-app.js")
  .then(({ mountApp }) => {
    const fragment = bootstrapFragment;
    bootstrapFragment = null;
    mountApp(fragment);
  })
  .catch(() => {
    bootstrapFragment = null;
    const root = document.getElementById("root");
    if (root) root.textContent = "First Tree could not start. Reload to try again.";
  });
