---
id: web-security-headers-csp
description: Validate that the app-wide browser security headers protect every response without the enforced CSP breaking real web console usage.
areas: [cross-surface]
surfaces: [server, web]
---

# App-Wide Security Headers And Enforced CSP

## Goal

Confirm that the server-stamped browser security headers (Content-Security-Policy, HSTS, `X-Content-Type-Options`,
`Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options`) are present on every response class **and** that the
enforced CSP does not break real web console usage in a browser. Product tests already pin the exact header values and
reply-path coverage (`packages/server/src/__tests__/security-headers.test.ts`); this case owns the judgment layer those
tests cannot see — a live browser executing the SPA under the enforced policy.

## Preconditions

- A running server that serves the built web dist (production image or `FIRST_TREE_WEB_DIST_PATH` boot), reached over
  its real HTTP boundary. Vite dev-server-only runs do not answer this case: dev module scripts and HMR do not match
  the shipped asset shape.
- A real browser with the devtools console open. CSP violations surface as console errors, not failed assertions.
- Do not disable the layer (`FIRST_TREE_SECURITY_HEADERS_ENABLED` stays default `true`).

## Operate And Observe

- Request `/`, a deep SPA route, an API route, and a missing asset with `curl -sI`; confirm each response carries the
  full header set and that the CSP includes `frame-ancestors 'none'` and a `script-src` without `unsafe-inline` or
  `unsafe-eval`.
- Load the console in the browser and complete a normal authenticated pass: sign in, open a workspace chat, send a
  message, watch live updates arrive (WebSocket), and open a page that shows member/agent avatars. Watch the devtools
  console for CSP violation reports the whole time.
- Confirm the theme boot still works under the external-script layout: with a dark OS/browser preference, first paint
  is dark with no light flash.
- Attachments and avatar uploads round-trip: upload an image, see its preview render (`blob:`/`data:` grants), and
  download an attachment.
- If validating against production (`cloud.first-tree.ai`), verify GA4 and Clarity loaders execute without violations;
  on staging/local these loaders are hostname-gated off, so their absence is expected, not a failure.

## Expected And Limitations

- Zero CSP violation reports during the authenticated pass. A violation naming a legitimate product origin means the
  configured allowlist (`FIRST_TREE_CSP_*_ORIGINS`) or its defaults must be updated — the fix is configuration, not
  weakening the code-owned policy shape.
- Remote images in chat markdown from arbitrary hosts are intentionally blocked by `img-src`; a blocked third-party
  image inside message markdown is expected behavior, not a regression.
- HSTS only takes effect over HTTPS; plain-HTTP local runs send the header but browsers ignore it.
