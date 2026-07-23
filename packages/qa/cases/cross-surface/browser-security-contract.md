---
id: browser-security-contract
description: Validate app-wide browser security headers, enforced least-privilege CSP, frame denial, and normal authenticated API, SPA, WebSocket, attachment, and telemetry behavior in the production server image.
areas: [cross-surface]
surfaces: [server, web, shared]
---

# Browser Security Contract

## Goal

Validate the browser-security contract at an exact candidate SHA through the
shipped production image: Fastify applies the required headers to API and SPA
responses, the enforced CSP admits every active browser dependency and no
unnecessary capability, authenticated journeys remain functional, arbitrary
Markdown images do not initiate network requests, and the dashboard cannot be
framed.

The checked-in Web browser-resource registry is source authority for bundled
integrations. The generated `browser-security-manifest.json` is that contract's
projection for the exact candidate artifact; runtime configuration supplies
environment-owned additions and the deployed allowlist. Do not treat either
projection as a second source registry, copy a vendor origin table into this
case, or infer permissions from a vendor name. Retain every observed request's
initiator/resource type. Bundled-integration requests must match an active
manifest requirement; environment-owned avatar/storage/edge requests must
match the source contract's conditional classification, candidate evidence,
runtime capability list, and corresponding emitted CSP directive.

## Formal Lifecycle And Readiness

This case is not selected for execution, and the run-local `plan.md` is not
created, until a complete harness at the exact candidate SHA reaches `QA READY`
for every shipped surface. Record only `run-context.md` and a provisional
readiness checklist before that gate. The per-surface readiness matrix must
explicitly cover the final CLI/package artifacts, the Server/Web production
image with Postgres, the documentation surface, portable release artifacts,
and runtime/daemon paths. Each row must have all six capabilities:

- **Build:** a run-local clone and detached worktree at the exact SHA plus the
  final artifact for every matrix row, including the release image and its
  generated browser manifest.
- **Run:** isolated database, network, volumes, and homes; run-local DNS plus a
  trusted HTTPS reverse proxy for the exact production hostname gate; a proven
  WSS upgrade path; and a separate nonproduction dev-auth cell built from the
  same SHA.
- **Drive:** a login journey that crosses a real production-compatible
  authentication boundary with recorded test credentials—the development
  callback is disabled in production. Seeded fixtures may establish accounts
  and data but cannot substitute for that boundary. Use two independent
  identities/contexts, or one browser plus a second real producer, so a
  received message cannot be mistaken for mutation cache or polling.
- **Observe:** a `securitypolicyviolation` listener installed before app
  navigation, console and page failures, request failures, raw response
  headers, WebSocket open/frames, proxy and server logs, and privacy-safe
  trace/HAR/screenshot evidence.
- **Measure:** install/build duration, artifact size, start-to-ready time, idle
  resource use, driver/observer latency, and reset/reprobe timing appropriate to
  each surface.
- **Reset:** a unique run root and Compose project, full teardown and clean
  rebuild, followed by a repeated smoke that proves isolation and resetability.

Use a build-time Sentry test DSN whose exact HTTPS origin routes to a controlled
capture target. Trigger one scrubbed synthetic event and prove receipt; without
that capability, the Sentry behavior is `BLOCKED`. Real GA and Clarity traffic
must be privacy-safe and coordinated with the analytics owner. Exact-origin
mocks can validate CSP mechanics but not provider receipt; without the
coordination, those provider behaviors and the overall end-to-end claim are
`BLOCKED`, never a partial `PASS`.

Candidate-origin evidence must remain separate from read-only observations of
the current public edge. Local Docker cannot prove conditional edge injection.
Test an edge dependency only when the exact candidate environment emits it. A
missing authentication, provider, browser, proxy, or platform capability is
`BLOCKED`, not permission to call a successful subset `PASS`. Reserve
`INCONCLUSIVE` for partial, unstable, contradictory, privacy-limited, or
unattributable evidence. The formal run never edits product code or this case
library.

## Operate

After `QA READY`, create the focused plan and exercise at least these paths in
Chromium and the other supported browser engines available to the harness:

1. Capture direct-origin and trusted-proxy responses for SPA root, deep link,
   static asset, API success, API error/404, redirect/download, and a static
   conditional response. Use a real GET (`curl -sS -D - -o /dev/null`) for GET
   claims, retain `curl -sS -I` only for explicit HEAD behavior, and send a real
   CORS preflight with `OPTIONS`, `Origin`, and
   `Access-Control-Request-Method` headers.

   ```sh
   curl -sS -D - -o /dev/null https://candidate.example/path
   curl -sS -I https://candidate.example/path
   curl -sS -X OPTIONS -H 'Origin: https://allowed.example' \
     -H 'Access-Control-Request-Method: GET' -D - -o /dev/null \
     https://candidate.example/api/v1/health
   ```

2. Parse every response's security headers. Prove the CSP is enforced rather
   than Report-Only, its script policy contains neither inline/eval escape
   hatch, no directive contains a wildcard, HSTS is at least one year with
   subdomains, MIME sniffing is disabled, referrer policy is strict across
   origins, sensitive browser permissions are denied, and both CSP and the
   legacy frame header deny ancestors. Compare parsed directives to the
   generated manifest's active required sets and retain exact unexpected-
   request/CSP-event counts.
3. Before app code runs, attach CSP/console/request/WebSocket observation. Log
   in through the production auth precondition, load the dashboard, create or
   open a chat, send from one identity and receive through the live WebSocket in
   the other context, then exercise configured avatars, an uploaded image
   attachment, and a document attachment preview/download. Correlate the send
   and receive with WebSocket event/message identifiers.
4. Render a Markdown message containing a unique controlled trap image URL.
   Confirm its alt/link UI remains usable and the trap origin receives zero
   requests. Confirm first-class image attachments still render through their
   authenticated attachment path.
5. Exercise every integration active in the generated candidate manifest.
   Trigger the controlled scrubbed Sentry event and, when owner coordination is
   available, the production-gated analytics/session-insight behavior. Record
   actual initiator/resource type and exact origin without retaining private
   payloads, cookies, identifiers, or credentials.
6. Load the dashboard URL inside a hostile cross-origin frame. Treat refusal as
   the expected negative result and retain both browser-visible and header/
   console evidence; do not count that deliberate refusal as an unexpected CSP
   violation.
7. Tear down the run cell, rebuild/reset it, and repeat the header, login, SPA,
   API, WebSocket, and trap-image smoke checks.

## Expected Result

`PASS` requires all ready, active paths above to succeed with zero unexpected
`securitypolicyviolation` events, zero CSP console errors, zero unclassified
external requests, exact manifest-to-directive inclusion, real WebSocket
receipt, functional avatar/attachment/document flows, zero trap-image request,
and successful hostile-frame denial. It also requires the reset smoke and all
owner/provider assertions needed by the active candidate manifest.

`FAIL` is a reproducible candidate defect: a missing/overwritten header,
Report-Only policy, forbidden script capability, wildcard or unexpected source,
boot accepting an incomplete active dependency set, an ordinary journey blocked
by CSP, a Markdown image fetch, failed frame denial, or a reset-reproducible
regression attributable to the exact SHA.

`BLOCKED` covers missing auth/provider/browser/proxy/platform capability or a
candidate that cannot be built/run in the complete harness. `INCONCLUSIVE`
covers partial, unstable, contradictory, privacy-limited, or unattributable
evidence.

## Evidence

Keep the exact SHA and image identity; parsed generated manifest and emitted
CSP; raw direct-origin and candidate-edge header lines; GET, HEAD, and OPTIONS
commands; browser/version and hostname/proxy configuration; CSP, console,
request, frame, and WebSocket observations; redacted Sentry/provider receipt;
trap-origin request count; screenshots/HAR/traces; reset commands and repeated
smoke result; and the final case disposition. Preserve duplicate header lines
so an edge overwrite is visible. A public edge exposing a shorter HSTS value is
an external visibility conflict, not proof that the candidate application
passes the one-year contract.
