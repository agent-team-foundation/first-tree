---
id: mobile-pwa-install-and-auth-handoff
description: Validate credential-free desktop QR discovery through real iOS and Android home-screen installation, standalone OAuth return, and desktop setup handoff.
areas: [cross-surface]
surfaces: [server, web]
---

# Mobile PWA install and auth handoff

## Goal

Confirm that a desktop user can discover the mobile PWA, scan a public same-origin QR code, install it through the
platform-supported path, and open the installed app into the existing mobile Work surface. The QR must carry no
credentials or private context. First use may require the product's existing OAuth flow, while an account that has not
completed setup must return to desktop rather than starting a second mobile onboarding.

Deterministic web tests own route gating, source allowlisting, install-prompt state, analytics payloads, and component
rendering. This case owns the live boundaries those tests cannot prove: a camera scan between physical devices, real
iOS and Android installation behavior, standalone launch, provider OAuth, persisted browser/app state, and the
incomplete-setup handoff.

## Preconditions

- An HTTPS deployment built from the target ref with the mobile channel enabled, a valid web app manifest, a browser
  that recognizes the platform's supported install path, and the same configured OAuth providers on desktop and
  mobile.
- A desktop browser plus a physical iPhone or iPad running Safari and a physical Android device running Chrome or
  another supported Chromium browser. Start with the PWA absent and clear disposable site data between independent
  branches.
- One disposable account that has completed desktop setup and one disposable account that is authenticated but still
  requires setup. Do not use production credentials or retain OAuth state, cookies, or tokens as evidence.
- A QR scanner or device camera. Android native-prompt eligibility is browser-controlled; inability to receive the
  prompt is a branch to exercise the manual fallback, not permission to simulate installation.

## Operate

Exercise both desktop discovery surfaces: finish Start chat and open its mobile-app promotion, then open **Open on
mobile** from the user menu. Use keyboard activation as well as a pointer, close the dialog with Escape, and verify
focus returns to its trigger. Scan each QR code and separately try the copy-link action. Decode each QR locally, retain
only its redacted payload, and inspect requests made while the QR is rendered.

On iOS, open the scanned page in Safari and follow its Share → Add to Home Screen → Open instructions. On Android,
exercise the native install action when the browser exposes it, dismiss it once, and confirm the page recovers to a
usable manual-install path. In a clean state where no native prompt is offered, complete the manual path directly.

Launch each installed app from the home-screen icon. With the completed account signed out on the device, use the
existing OAuth provider once and follow the return into mobile Work. Close and reopen the installed app to check that a
valid session is reused. Then repeat the first-launch path with the incomplete account and use both recovery actions:
copy the desktop setup link, transfer that public URL to a desktop browser and open its `/onboarding` destination, and
switch to another account.

Also open an install URL with an unknown source value. Interrupt either the install-page or manifest load, and an OAuth
navigation or callback, with a temporary network failure before retrying; do not try to manipulate the operating
system's native confirmation sheet. Use a narrow phone viewport and devices with safe-area insets.

Channel gating and analytics remain companion deterministic checks. If an isolated harness already exposes a controlled
unusable-channel bootstrap response, confirm that a direct install visit recovers to the desktop root; do not mutate a
valid deployment or simulate a product response merely to make this live branch available.

## Observe

- Start chat remains the primary desktop action; mobile discovery is secondary there and remains available from the
  user menu. The entry and dialog have readable names, visible keyboard focus, keyboard activation, Escape dismissal,
  and focus restoration. The Start-chat cards do not overflow a narrow phone-width layout.
- Every QR and copied URL stays on the current origin and points only to the public mobile install entry with an
  allowlisted attribution source. It contains no user, Team, workspace, setup, cookie, token, OAuth state, or other
  credential data, and rendering the QR does not call a third-party QR service.
- The public page presents truthful platform-specific instructions. iOS requires the operating system's Add to Home
  Screen action. Android offers a single native install action only when the browser makes it available; a user
  dismissal or a browser that offers no prompt leaves usable manual instructions.
- The installed icon launches in standalone display mode and reaches the existing mobile Work surface. An
  unauthenticated user completes the existing OAuth flow and returns to mobile Work without receiving a credential
  from the desktop QR or repeating product onboarding. Safe-area content remains reachable, and neither standalone
  login nor OAuth completion loops back to the install page.
- A valid mobile session survives an ordinary app close and reopen. An expired or failed session returns to normal
  OAuth with an actionable retry instead of looping through installation.
- The incomplete account sees the desktop setup handoff. Its copied link opens the desktop setup path, while switching
  accounts allows a configured account to continue; the mobile app does not import desktop configuration or expose a
  parallel setup flow.
- Unknown attribution is normalized to the bounded direct source and the public install page remains usable; the
  unknown value does not gain authorization meaning or pass through to telemetry. When a real unusable-channel response
  is available, it fails closed to the normal desktop entry. After a transient network fault, the product retains a
  clear retry or manual recovery path and does not enter a product-owned loop. A provider, platform, or environment
  outage that prevents attribution to the target is `BLOCKED` or `INCONCLUSIVE`, not a target failure.

## Evidence

Keep screenshots or a short recording of both desktop entry points, the decoded same-origin QR paths with any
deployment hostname redacted, the iOS and Android install branches, the resulting home-screen icon, standalone display
mode, the final `/m/work` destination after OAuth, and incomplete-setup handoff. Record only a callback's fixed pathname
if needed; strip its search and hash before capture and never export or record the complete callback URL. Browser
network logs may establish the absence of a third-party QR request. Record the device, OS, browser, target ref, channel
state, and whether Android used the native or manual branch.

Use the companion deterministic product results for source normalization, unusable-channel routing, bounded analytics
keys, privacy-sensitive analytics exclusions, standalone first-open deduplication, and recovery from failed or stale
Android prompt objects that cannot be reliably manufactured on a physical browser. A non-production live run should
not be expected to emit production-only analytics.

Never retain cookies, tokens, OAuth authorization codes or state, credentials, private source, user identifiers, Team
identifiers, or unredacted production analytics.

## Expected behavior and limitations

`PASS` requires a credential-free scan, real installation on both platform families, standalone launch through existing
OAuth into Work, a durable desktop handoff for incomplete setup, usable manual Android instructions after a dismissal
or absent prompt, and safe product recovery from a transient network fault. `FAIL` includes credential-bearing QR data,
an external QR-rendering request, an installation dead end, auth return outside mobile Work, repeated mobile
onboarding, or a reproducible product-owned recovery loop. `BLOCKED` applies when physical devices, platform install
support, OAuth, or an eligible deployment are unavailable; `INCONCLUSIVE` applies when an external outage prevents
attribution. Source inspection or simulated browser events alone cannot upgrade the live journey to `PASS`.
