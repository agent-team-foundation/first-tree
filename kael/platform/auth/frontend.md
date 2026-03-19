---
title: Frontend Authentication
owners: []
---

# Frontend Authentication

## BetterAuth Setup

BetterAuth is configured in `kael-frontend/src/lib/auth.ts`. It connects to PostgreSQL for session storage and handles all user-facing auth flows.

- Base URL resolved from: `BETTER_AUTH_URL` > `NEXT_PUBLIC_BASE_URL` > `VERCEL_URL` > `VERCEL_BRANCH_URL` > `localhost:3000`
- Trusted origins dynamically built from env vars + Vercel URLs
- Email verification required, sent via Mailgun (fire-and-forget to avoid timing attacks)
- Social auth: Google OAuth

## Session Flow

1. User authenticates via BetterAuth (sign-in page)
2. BetterAuth creates a session in PostgreSQL, sets secure HttpOnly cookie
3. API routes call `getAuthContext()` to extract `user_id` from session
4. `user_id` is passed to backend as a request parameter alongside `X-Internal-API-Key`

Dev mode: `NEXT_PUBLIC_DEV_USER_ID` bypasses session check for local development.

## Middleware

Next.js middleware (`kael-frontend/src/middleware.ts`) runs on Edge Runtime:
- Checks BetterAuth session on every request
- Redirects unauthenticated users to `/auth/sign-in`
- Rejects anonymous users from protected paths
- Public paths exempted: `/api/auth`, `/auth`, `/_next`, static assets

## Anonymous Users

BetterAuth anonymous plugin allows unauthenticated usage. On sign-up/login, resources (projects, sessions) transfer from anonymous account to real account via dedicated transfer APIs.

## Device Auth Callbacks

The frontend serves as the auth broker for browser extension and desktop app:

- `GET /api/auth/browser-extension-callback` — validates BetterAuth session, requests JWT from backend, redirects to `chromiumapp.org` with token in URL fragment
- `GET /api/auth/desktop-app-callback` — validates BetterAuth session, requests JWT from backend, redirects to localhost callback with token in query params
