// Applies the persisted theme before first paint so the user never sees a
// flash of the wrong color scheme (FOUC). index.html loads this synchronously
// from <head> (no async/defer) to preserve that guarantee.
//
// External file, not an inline script: the enforced Content-Security-Policy
// ships without script-src 'unsafe-inline', so every script the SPA runs must
// come from an allowed origin ('self' here).
(() => {
  const t = localStorage.getItem("theme");
  const m = window.matchMedia("(prefers-color-scheme: dark)").matches;
  if (t === "dark" || (!t && m)) document.documentElement.classList.add("dark");
})();
