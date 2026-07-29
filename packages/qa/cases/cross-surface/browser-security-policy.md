---
id: browser-security-policy
description: Validate enforced browser security headers without breaking authenticated SPA, WebSocket, avatar, attachment, or document-preview flows.
areas: [cross-surface]
surfaces: [server, web]
---

# Browser Security Policy

## Goal

Confirm that the production server applies the complete enforced browser security policy to SPA, API, health, asset, and
error responses. Confirm through real browser boundaries that the policy does not block supported application behavior.
Use this case for changes to Content Security Policy (CSP), external browser resources, or server-wide response headers.
Stable header values and source-list construction belong in product tests.

## Preconditions

- Use an isolated Docker-backed run cell and a temporary worktree at the exact target ref.
- Build and run the production server image with an isolated PostgreSQL database and valid run-local secrets.
- Configure `FIRST_TREE_PUBLIC_URL` for the browser origin. Configure exact CSP origins for every run-local external
  dependency. Do not use wildcards, reporting-only policies, or browser extensions that modify CSP.
- Use a throwaway account with one connected runtime. Prepare an avatar, an attachment, and a document that can be
  previewed. Keep credentials, cookies, tokens, and private content out of retained evidence.
- Open browser developer tools before authentication. Preserve the Console and Network panels across navigation.

## Operate

1. Request the SPA root, one deep SPA route, `/api/v1/health`, a static asset, and known API and asset misses over the
   production HTTP boundary.
2. Complete login and navigate through the authenticated workspace.
3. Open an existing chat, send a message, receive a runtime response, and observe a WebSocket-driven update.
4. Load local and configured remote avatars. Upload and download an attachment.
5. Open a document preview and exercise its normal navigation.
6. Attempt to embed the SPA from a separate run-local origin.
7. Inspect browser Console and Network evidence for blocked resources, CSP violations, failed WebSocket connections, and
   unexpected external origins.

## Observe

- Every sampled response has an enforced `Content-Security-Policy`,
  `Strict-Transport-Security: max-age=31536000; includeSubDomains`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy` that disables camera, microphone, geolocation, and payment, and `X-Frame-Options: DENY`.
- CSP contains `frame-ancestors 'none'`. The separate-origin frame attempt is blocked.
- `script-src` contains neither `'unsafe-inline'` nor `'unsafe-eval'`. The shipped HTML has no inline script execution.
- Login, SPA navigation, chat send and receive, same-origin WebSocket updates, avatars, attachment transfer, and document
  preview complete without CSP violations.
- Network evidence contains only same-origin requests and exact configured external origins. A newly required object
  store, analytics host, avatar host, or observability host is supplied through configuration, not a wildcard.
- API, health, asset, 404, and bodyless responses retain the same security-header contract.

## Expected Result

`PASS` when all required headers are enforced on every sampled response, framing is denied, supported browser workflows
complete, and the Console contains no CSP violation attributable to the target.

`FAIL` when any response omits or weakens a required header, CSP uses a wildcard or unsafe script source, the SPA can be
framed, or an in-scope workflow is blocked by the policy.

`BLOCKED` when the isolated production stack, browser, account, connected runtime, or required test data cannot reach
`QA READY`.

`INCONCLUSIVE` when the evidence does not cover every required response class and browser workflow, or a provider failure
cannot be separated from the target.

## Evidence

Keep the target commit, production image identifier, redacted response headers, representative Network request
names/statuses/origins, Console output, WebSocket state, and screenshots of successful attachment and document-preview
flows plus the blocked frame attempt. Do not retain cookies, authorization headers, tokens, private message content, or
uploaded file contents.
