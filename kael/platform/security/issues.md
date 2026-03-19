---
title: Security Issues & Proposed Solutions
owners: []
---

# Security Issues & Proposed Solutions

Findings from security review conducted 2026-03-17.

---

## S1: kael-logger holds overprivileged credentials

**Severity: Critical | Priority: P0**

kael-logger is an analytics tool that holds credentials far exceeding its needs:

1. **Direct BetterAuth database access** — `DATABASE_URL` points to BetterAuth's PostgreSQL. kael-logger can read the `session` table containing active session tokens, enabling full user impersonation. The `/api/users` endpoint exposes all user emails, names, and IDs.
2. **Shares `INTERNAL_API_KEY` with kael-frontend** — can call any kael-backend endpoint as any user by passing arbitrary `user_id` parameters.

A compromised kael-logger (or anyone with login access) gets: user identities, session tokens for impersonation, and full backend API access.

**Proposed solution:**
- Remove direct BetterAuth database access — kael-logger should never see session tokens
- Create a dedicated `kael_reader` database role (read-only, scoped to analytics-relevant tables)
- Remove `INTERNAL_API_KEY` — replace with scoped, read-only access to backend analytics endpoints
- Must be resolved before RLS implementation (see S3)

---

## S2: Static INTERNAL_API_KEY for frontend-to-backend auth

**Severity: High | Priority: P1**

A single static shared secret authenticates all frontend-to-backend communication. `user_id` is passed as a plain request parameter, trusted only because the API key is present.

Problems:
- Anyone with this key can call the backend as **any user**
- No rotation mechanism — if the key leaks, both services must be updated simultaneously
- The key is transmitted in every request (inside TLS, but still)
- Same key shared across kael-frontend and kael-logger

**Proposed solution: RS256-signed service tokens**
- Frontend mints short-lived JWTs (10min expiry) with `user_id` embedded in claims, signed with RS256 private key
- Backend verifies with public key only — cannot forge tokens even if compromised
- Private key stored on Vercel (frontend only); backend holds only the public key
- `user_id` becomes cryptographically trusted, not just a parameter

Rationale for Vercel as private key host: backend environment has larger attack surface (sandbox/desktop/browser WebSocket connections, agent access). Keeping the signing key on Vercel is significantly safer.

Open questions:
1. Can BetterAuth be extended to issue these tokens, or implement as standalone JWT signing?
2. Migration path — dual support during transition
3. Token caching strategy to avoid minting per-request

---

## S3: No database Row-Level Security (RLS)

**Severity: High | Priority: P1**

User data isolation relies entirely on application-level `WHERE user_id = ?` filters. No PostgreSQL RLS policies enforce isolation at the database level.

Risks:
- A missing `WHERE` clause in any repository method leaks cross-user data
- A compromised backend with database access can query all users' data
- SQL injection (unlikely with SQLAlchemy ORM) would bypass all isolation

**Proposed solution: PostgreSQL RLS with role separation**

Three database roles:
| Role | Used by | Access |
|---|---|---|
| `kael_admin` | CI/CD migrations only | Table owner, BYPASSRLS, schema changes |
| `kael_app` | kael-backend runtime | RLS enforced, read/write, scoped to current user |
| `kael_reader` | kael-logger | Read-only, BYPASSRLS for analytics |

Backend sets `SET LOCAL app.current_user_id = '{user_id}'` before every query. RLS policies filter all tables by this value. Combined with RS256 tokens (S2), the `user_id` is cryptographically trusted end-to-end.

`kael_admin` credentials stored only in CI/CD secrets (GitHub Actions), never in backend environment.

Dependency: kael-logger credential scoping (S1) must be resolved first — current architecture is incompatible with role separation.

---

## S4: Backend public URL exposure

**Severity: Medium | Priority: P2**

The backend has a public URL (`kael-backend.deploy.unispark.dev` / `api.kael.im`). Security relies on URL obscurity + static API key. If the URL leaks (logs, error messages, DNS records), the only protection is `INTERNAL_API_KEY`.

**Proposed solution: Private networking with split WebSocket gateway**
- Move backend API behind private networking (no public IP)
- Frontend connects via Vercel Private Networking or VPC peering
- WebSocket endpoints remain public but as a narrow, JWT-gated surface

Open questions:
1. Does the deployment platform (deploy.unispark.dev) support private networking / VPC peering with Vercel?
2. WebSocket gateway architecture for the public surface

---

## S5: Shared JWT_SECRET_KEY for extension and desktop tokens

**Severity: Medium | Priority: P2**

Both browser extension and desktop app tokens are signed with the same `JWT_SECRET_KEY`. The `type` claim distinguishes them, but a key compromise affects both token types simultaneously.

**Proposed solution:**
- Use separate signing keys per token type
- A compromise of the extension key would not affect desktop connections and vice versa

---

## S6: JWT token in WebSocket URL

**Severity: Low | Priority: P3**

WebSocket connections pass the JWT as a query parameter (`?token={jwt}`). This token could appear in server access logs, load balancer logs, or proxy logs. This is a known WebSocket limitation (WebSocket handshake doesn't support custom headers).

**Mitigation:**
- Ensure server/proxy log configurations redact query parameters
- Short token expiry limits exposure window
- No fix possible without a protocol change (e.g., ticket-based auth where a short-lived opaque ticket is exchanged for the JWT after connection)

---

## S7: kael-logger API routes potentially unprotected

**Severity: Critical | Priority: P0 (pending verification)**

`proxy.ts` implements Basic Auth but is not named `middleware.ts` (required by Next.js) and is not imported anywhere. If no deployment-level auth (e.g., Vercel Authentication) is in place, all API routes are completely open — including a `DELETE /api/users/:userId` endpoint that permanently deletes users and their sessions without any authorization check.

**Status:** Needs verification — the app requires login in practice, which may come from deployment-layer protection. If deployment auth is confirmed, downgrade to Medium (defense-in-depth gap). If not, this is an actively exploitable vulnerability.

**Proposed solution:**
- Verify deployment-level auth coverage
- Rename `proxy.ts` to `middleware.ts` or implement proper Next.js middleware regardless (defense-in-depth)
- Add per-route authorization checks — the DELETE endpoint should require explicit admin privileges even behind auth

---

## S8: kael-logger SSRF with INTERNAL_API_KEY exfiltration

**Severity: Critical | Priority: P0**

`/api/files/content?url=` fetches arbitrary user-supplied URLs. The `backendHeaders()` helper injects `INTERNAL_API_KEY` into the request headers sent to the target URL. An attacker (or anyone with kael-logger access) can:

1. Point the URL to their own server → receive `INTERNAL_API_KEY` in the request headers
2. Point to `http://169.254.169.254/...` → access cloud metadata (AWS/GCP credentials)
3. Point to internal services → scan private network

**Proposed solution:**
- Remove `backendHeaders()` from the content fetch route — it should not send internal credentials to arbitrary URLs
- Add URL allowlist or blocklist for private IP ranges
- Add request size and timeout limits

---

## S9: Desktop app file read lacks client-side path enforcement

**Severity: Medium | Priority: P2**

The backend's `ResourceAccessService` gates file paths through a privacy deny list (blocks `.ssh/*`, `.env`, credentials files, etc.) and user confirmation before commands reach the desktop app. However, `file.rs:read_file()` on the Tauri side accepts any absolute path with no second check. The `base_directory` setting exists but is not enforced as a boundary.

This means: under normal operation, the backend's resource access control prevents sensitive file reads. But if the backend is compromised (attacker has live WebSocket handles), it can send `file_read` commands directly to the desktop app bypassing all safety layers.

**Proposed solution:**
- Enforce `base_directory` as a client-side boundary in `file.rs` (defense-in-depth)
- Replicate the privacy deny list on the Tauri side (same pattern as the deny list, which already exists on both backend and desktop)
- Require user confirmation for file reads outside the base directory

---

## S10: Browser extension captures sensitive input values unmasked

**Severity: High | Priority: P1**

The content script's accessibility tree builder (`accessibility.ts`) only masks `<input type="password">`. All other input types — including credit card numbers, SSNs, email addresses, OTP codes — are captured as plaintext and sent to the backend via WebSocket.

The user action monitor (`user-action-monitor.ts`) also captures the first 200 characters of any input field value during the "thinking" phase without masking.

**Proposed solution:**
- Mask all inputs with sensitive `autocomplete` attributes (`cc-number`, `cc-csc`, `one-time-code`, etc.)
- Mask inputs whose `name`/`id` match sensitive patterns (`card`, `ssn`, `cvv`, `otp`, etc.)
- Consider not capturing input values by default — only capture when explicitly needed by an agent action

---

## S11: Backend agent downloads lack SSRF protection

**Severity: Medium | Priority: P2**

`download_tools.py` validates URL scheme (http/https only) but does not block private IP ranges. An agent could be instructed to fetch `http://169.254.169.254/latest/meta-data/` (cloud metadata), `http://127.0.0.1:8000/` (backend itself), or other internal services.

**Proposed solution:**
- Add blocklist for private/reserved IP ranges (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16)
- Resolve DNS before connecting to catch DNS rebinding attacks
- Add connection timeout limits

---

## S12: Frontend missing Content-Security-Policy header

**Severity: Medium | Priority: P2**

The main application (`next.config.ts`) sets security headers (HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy) but has no Content-Security-Policy. CSP is the primary defense-in-depth against XSS. Only the `/view/[assetId]` route has CSP configured.

Additionally, the `/view/[assetId]` route renders markdown via `marked.parse()` without sanitization (e.g., DOMPurify), which could allow XSS through malicious markdown content inside the iframe.

**Proposed solution:**
- Add CSP header to the main application
- Sanitize markdown HTML output with DOMPurify before rendering

---

## S13: Desktop deny list regex bypasses

**Severity: Medium | Priority: P2**

The shell command deny list (`deny_list.rs`) uses regex patterns that can be bypassed with alternative syntax:
- `rm -rf /` is blocked, but `rm --recursive --force /` (long flags) is not
- `rm -r -f /` (separated flags) is not caught
- `curl | sh` is blocked, but `curl ... > /tmp/s.sh && sh /tmp/s.sh` is not
- `chmod 000 /` is blocked, but `chmod 0 /` is not

**Proposed solution:**
- Expand patterns to cover long-form flags and alternative syntax
- Consider a command parser instead of regex for more robust detection
- Note: deny lists are inherently bypassable — the confirmation flow is the more important safety layer

---

## S14: Error messages leak internal details

**Severity: Medium | Priority: P2**

Both kael-backend and kael-logger return raw exception strings (`str(exc)` / `` `${err}` ``) in 500 error responses. These can expose database connection details, SQL query fragments, file paths, and internal service structure.

Affected: multiple endpoint files across both services.

**Proposed solution:**
- Implement global exception handlers that log full details server-side but return generic messages to clients
- Backend: FastAPI exception handler middleware
- kael-logger: wrapper utility for API route error responses

---

## S15: Sandbox credentials exposed to agent

**Severity: High | Priority: P1**

User credentials (OAuth tokens, GitHub PAT, Kael API key) are injected into the sandbox as environment variables and files. The sandbox has full outbound internet. A prompt-injected agent could exfiltrate these credentials to any approved or unchecked external URL.

See [platform/agent-security/sandbox-credentials.md](../agent-security/sandbox-credentials.md) for details and proposed solutions.

---

## S16: Output filter not applied to all context sources

**Severity: High | Priority: P1**

`output_filter.py` redacts secrets from desktop command output before it enters the agent's LLM context, but is not applied to sandbox output, browser page content, file reads, or web fetch results.

See [platform/agent-security/context-filtering.md](../agent-security/context-filtering.md) for details and proposed solution.

---

## Accepted Risks

### Browser extension broad permissions

The browser extension requires `<all_urls>` host permissions, `debugger` (Chrome DevTools Protocol), and content script injection on all pages. These are inherent to its purpose as a browser automation tool — the agent needs to operate on any webpage the user visits.

**Mitigations in place:**
- User confirmation flow before destructive actions
- Password fields masked in accessibility tree
- Chrome enforces extension isolation (per-extension storage, message passing)
- Extension updates go through Chrome Web Store review

**Residual risk:** A compromised backend could send commands to automate actions on any page the user visits (banking, email, etc.) through the existing WebSocket connection. This is the fundamental trust model of a browser automation tool — the user trusts the backend to send legitimate commands.
