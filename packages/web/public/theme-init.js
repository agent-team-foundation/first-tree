/**
 * Theme boot — applies the dark class before first paint so a dark-mode user
 * never sees a light flash. Loaded as a synchronous (blocking) same-origin
 * script from index.html rather than an inline block: the app-wide CSP
 * forbids inline scripts (`script-src 'self' …`, no `unsafe-inline` — see
 * packages/server/src/security-headers.ts), and being external keeps it
 * enforceable without nonce plumbing through the static file server.
 */
(() => {
  const t = localStorage.getItem("theme");
  const m = window.matchMedia("(prefers-color-scheme: dark)").matches;
  if (t === "dark" || (!t && m)) document.documentElement.classList.add("dark");
})();
