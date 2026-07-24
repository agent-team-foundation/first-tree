---
id: browser-security-policy-journeys
description: Validate enforced browser security headers without breaking the authenticated Web Console journeys or their exact external dependencies.
areas: [cross-surface]
surfaces: [server, web]
---

# Browser Security Policy Journeys

## Goal

Confirm that the production server applies one enforced browser security policy to SPA and API responses while the real
Web Console remains functional. This case owns the live browser boundary that response-injection tests cannot prove:
browser CSP enforcement, WebSocket behavior, deployed analytics, remote avatars, and blob-backed previews.

## Preconditions

- Run the shipped production artifact from the target ref in an isolated Docker-backed cell with HTTPS and a disposable
  account, organization, agent, chat, attachment, and document. Do not reuse operator credentials or production data.
- Configure only the exact external origins the deployment actually uses. Test the production Cloud defaults separately
  from a staging or localhost host, where production analytics must remain disabled.
- Use a clean browser profile without extensions. Clear the console and network log immediately before each journey and
  preserve only redacted evidence.

## Operate

1. Request the SPA root, an SPA deep link, a successful API route, and an API error. Capture their response headers and
   confirm the enforced policy is consistent across the application.
2. Sign in, open an existing chat, send a message, receive a reply over the authenticated WebSocket, and reconnect once.
3. Visit a screen with a remote member avatar. Upload and download an attachment, then open an image or document preview
   that uses a `blob:` or `data:` URL.
4. On the production Cloud host, exercise a route change long enough for GA4, Clarity, Cloudflare Web Analytics, and
   browser error monitoring to make their normal requests. Repeat on staging or localhost and confirm those production
   analytics scripts and requests are absent.
5. From a second origin, attempt to frame the Web Console and confirm the browser refuses it.

## Observe

- Each sampled response includes enforced CSP, one-year HSTS with subdomains, `nosniff`,
  `strict-origin-when-cross-origin`, disabled camera/microphone/geolocation/payment, and both CSP and legacy frame denial.
- `script-src` contains neither `unsafe-inline` nor `unsafe-eval`; the browser executes only external application or
  explicitly configured production scripts.
- Login, routing, chat, WebSocket reconnect, avatar rendering, attachment transfer, and document preview complete with no
  CSP violation, blocked-resource, mixed-content, or uncaught application error in the browser console.
- Every allowed cross-origin request matches an exact configured origin. No wildcard or unobserved analytics/CDN origin
  is needed, and non-production hosts make no production analytics requests.

## Expected Result

`PASS` when the headers are present app-wide, framing is refused, all listed journeys work, and the browser reports zero
CSP violations with an exact minimum origin set. `FAIL` for a missing or report-only header, a policy bypass, an
unexpected external origin, or a product journey broken by enforcement. `BLOCKED` when the isolated HTTPS deployment,
browser, disposable data, or required external provider is unavailable. `INCONCLUSIVE` when browser evidence is partial
or cannot be tied to the target ref.

## Evidence

Keep redacted response headers, browser console output, request origin/type/status summaries, WebSocket frames limited to
message types and status, the framing refusal, and screenshots of the completed journeys. Never retain tokens, cookies,
message bodies, attachment contents, document text, or stable user and organization identifiers.
