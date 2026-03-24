---
title: "Agent Hub Web Admin Console Design"
status: draft
owners: [baixiaohang]
soft_links: [proposals/agent-hub-overview.20260320.md]
---

# Agent Hub Web Admin Console Design

This document defines the Web admin console implementation plan, deployment architecture, and step-by-step execution plan for agent-hub/web.

---

## 1. Goals

The Web admin console provides a browser-based management interface for Agent Hub administrators:

| Feature | Description |
|---------|-------------|
| **Login** | Username/password → JWT auth |
| **Overview** | Dashboard with system stats (agent count, online count, chat count) |
| **Agent management** | CRUD agents, generate/revoke tokens |
| **System config** | Edit runtime parameters (inbox timeout, retry count, etc.) |

The Web consumes the existing Admin API (14 endpoints) defined in the Server.

---

## 2. Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| **Framework** | React 19 + Vite | Already configured in packages/web; SPA is sufficient for admin console |
| **Routing** | React Router v7 | Standard, mature SPA routing |
| **Styling** | Tailwind CSS v4 | Aligned with kael-frontend; `@theme` native syntax |
| **UI components** | shadcn/ui (Radix + Tailwind) | Components live in-project; admin-friendly (Table/Form/Dialog); same Radix foundation as kael |
| **Icons** | Lucide React | Aligned with kael-frontend |
| **Data fetching** | TanStack Query v5 | Caching, loading states, auto-refetch — valuable for admin dashboards |
| **API client** | Native fetch wrapper | Lightweight; response validation with `@agent-hub/shared` Zod schemas |
| **Auth state** | React Context | Sufficient scale; no Redux/Zustand needed |
| **Utilities** | clsx + tailwind-merge | Class name composition; same as kael-frontend |

**Not introducing:** Next.js (no SSR needed), Subframe (commercial; shadcn/ui is better fit for admin), state management libraries.

---

## 3. Deployment Architecture

### 3.1 Production: Server Embeds Web Static Files

```
                    https://hub.example.com
                              │
                              ▼
                    ┌─────────────────────┐
                    │   agent-hub server   │
                    │                     │
                    │  /api/*  → API      │
                    │  /*      → Web SPA  │
                    └──────────┬──────────┘
                               │
                          PostgreSQL
```

- `pnpm build` builds Web into `packages/web/dist/` (static HTML/JS/CSS)
- Server uses `@fastify/static` to serve Web's dist at runtime
- All API routes are prefixed with `/api`
- Non-`/api` routes fall back to `index.html` (SPA routing)
- Single port, single process, single domain, no CORS

### 3.2 Development: Two Independent Processes

```
Terminal 1: Server (API only, port 8000)
  $ pnpm --filter @agent-hub/server dev

Terminal 2: Web (Vite dev server, port 5173)
  $ pnpm --filter @agent-hub/web dev
  → Vite proxy: /api/* → http://localhost:8000
```

### 3.3 Server Configuration

```typescript
// New env var
WEB_DIST_PATH?: string  // Default: resolved from @agent-hub/web package
```

Server startup logic:

```typescript
if (config.webDistPath && existsSync(config.webDistPath)) {
  app.register(fastifyStatic, { root: config.webDistPath });
  app.setNotFoundHandler((req, reply) => {
    if (!req.url.startsWith("/api")) {
      return reply.sendFile("index.html");
    }
    reply.status(404).send({ error: "Not found" });
  });
}
```

### 3.4 CLI Integration (Future)

```bash
agent-hub server start     # Starts Server (API + Web static files)
agent-hub client start     # Starts Agent Runtime
```

### 3.5 Monorepo Structure (Unchanged)

```
packages/
├── shared/      # Shared Zod schemas + types
├── server/      # API server + static file hosting
├── client/      # Agent Runtime
└── web/         # Web source code (builds to dist/)
```

Web and Server remain independent packages. Turborepo enforces build order (web before server).

---

## 4. API Route Migration

All Server routes gain `/api` prefix. No functional changes, only path prefix.

### 4.1 Before → After

| Before | After |
|--------|-------|
| `GET /health` | `GET /api/health` |
| `POST /admin/auth/login` | `POST /api/admin/auth/login` |
| `POST /admin/auth/refresh` | `POST /api/admin/auth/refresh` |
| `GET /admin/agents` | `GET /api/admin/agents` |
| `POST /admin/agents` | `POST /api/admin/agents` |
| `GET /admin/agents/:agentId` | `GET /api/admin/agents/:agentId` |
| `PATCH /admin/agents/:agentId` | `PATCH /api/admin/agents/:agentId` |
| `DELETE /admin/agents/:agentId` | `DELETE /api/admin/agents/:agentId` |
| `POST /admin/agents/:agentId/tokens` | `POST /api/admin/agents/:agentId/tokens` |
| `GET /admin/agents/:agentId/tokens` | `GET /api/admin/agents/:agentId/tokens` |
| `DELETE /admin/agents/:agentId/tokens/:tokenId` | `DELETE /api/admin/agents/:agentId/tokens/:tokenId` |
| `GET /admin/system/config` | `GET /api/admin/system/config` |
| `PATCH /admin/system/config` | `PATCH /api/admin/system/config` |
| `GET /admin/overview` | `GET /api/admin/overview` |
| `GET /agent/me` | `GET /api/agent/me` |
| `POST /agent/chats` | `POST /api/agent/chats` |
| `GET /agent/chats` | `GET /api/agent/chats` |
| `GET /agent/chats/:chatId` | `GET /api/agent/chats/:chatId` |
| `POST /agent/chats/:chatId/participants` | `POST /api/agent/chats/:chatId/participants` |
| `DELETE /agent/chats/:chatId/participants/:agentId` | `DELETE /api/agent/chats/:chatId/participants/:agentId` |
| `POST /agent/chats/:chatId/messages` | `POST /api/agent/chats/:chatId/messages` |
| `GET /agent/chats/:chatId/messages` | `GET /api/agent/chats/:chatId/messages` |
| `POST /agent/agents/:agentId/messages` | `POST /api/agent/agents/:agentId/messages` |
| `GET /agent/inbox` | `GET /api/agent/inbox` |
| `POST /agent/inbox/:entryId/ack` | `POST /api/agent/inbox/:entryId/ack` |
| `POST /agent/inbox/:entryId/renew` | `POST /api/agent/inbox/:entryId/renew` |
| `WS /agent/ws/inbox` | `WS /api/agent/ws/inbox` |

### 4.2 Implementation

In `app.ts`, wrap all route registrations under a single `/api` prefix:

```typescript
app.register(async (api) => {
  // Public
  api.register(healthRoutes);
  api.register(adminAuthRoutes, { prefix: "/admin/auth" });

  // Admin (JWT protected)
  api.register(async (admin) => {
    admin.addHook("onRequest", adminAuthMiddleware);
    admin.register(adminAgentRoutes, { prefix: "/admin/agents" });
    admin.register(adminSystemConfigRoutes, { prefix: "/admin/system" });
    admin.register(adminOverviewRoutes, { prefix: "/admin" });
  });

  // Agent (Token protected)
  api.register(async (agent) => {
    agent.addHook("onRequest", agentAuthMiddleware);
    agent.register(agentRoutes, { prefix: "/agent" });
  });
}, { prefix: "/api" });
```

### 4.3 Impact on Client SDK

The `@agent-hub/client` package must use `/api` prefix in all HTTP calls. Since client SDK is not yet implemented, this is just a note for future work.

---

## 5. Web Pages

| Page | Route | API Consumed | Features |
|------|-------|-------------|----------|
| **Login** | `/login` | `POST /api/admin/auth/login` | Username/password form, JWT storage |
| **Overview** | `/` | `GET /api/admin/overview` | Stat cards (agents, online, chats) |
| **Agent list** | `/agents` | `GET /api/admin/agents` | Paginated table, create dialog, delete action |
| **Agent detail** | `/agents/:id` | `GET/PATCH /api/admin/agents/:id`, `GET/POST/DELETE tokens` | Info edit + token management |
| **Settings** | `/settings` | `GET/PATCH /api/admin/system/config` | Key-value edit form |

---

## 6. Web Project Structure

```
packages/web/src/
├── main.tsx                     # Entry: mount App
├── app.tsx                      # App: Provider composition (Router + Query + Auth)
├── index.ts                     # Barrel export
│
├── api/
│   ├── client.ts                # fetch wrapper (baseUrl, token injection, 401 refresh, error handling)
│   ├── auth.ts                  # login(), refreshToken()
│   ├── agents.ts                # listAgents(), createAgent(), getAgent(), updateAgent(), deleteAgent()
│   ├── tokens.ts                # createToken(), listTokens(), revokeToken()
│   ├── system-config.ts         # getConfigs(), updateConfigs()
│   └── overview.ts              # getOverview()
│
├── auth/
│   ├── auth-context.tsx         # AuthContext + AuthProvider (JWT storage/refresh/logout)
│   └── require-auth.tsx         # Route guard component
│
├── components/
│   ├── ui/                      # shadcn/ui components (button, input, table, dialog, badge, card, ...)
│   └── layout.tsx               # Sidebar + top bar layout shell
│
├── pages/
│   ├── login.tsx                # Login page
│   ├── overview.tsx             # Overview dashboard
│   ├── agents.tsx               # Agent list page
│   ├── agent-detail.tsx         # Agent detail page (info + tokens)
│   └── settings.tsx             # System config page
│
└── lib/
    └── utils.ts                 # cn() helper, date formatting
```

---

## 7. Core Modules

### 7.1 API Client (`api/client.ts`)

- Unified `apiClient.get/post/patch/delete` methods
- Auto-inject `Authorization: Bearer {accessToken}` header
- On 401: attempt token refresh via `POST /api/admin/auth/refresh`; if refresh fails, redirect to login
- Unified error handling (parse error response body)

### 7.2 Auth Context (`auth/auth-context.tsx`)

- Store `accessToken` / `refreshToken` in localStorage
- Expose `login()` / `logout()` / `isAuthenticated`
- Token refresh logic (called by API client on 401)

### 7.3 Route Guard (`auth/require-auth.tsx`)

- Not authenticated → redirect to `/login`
- Authenticated → render child routes

### 7.4 Layout (`components/layout.tsx`)

- Sidebar navigation: Overview, Agents, Settings
- Top bar: current user info, logout button
- Content area: renders routed page component

---

## 8. New Dependencies

### Web package

```
react-router                    # SPA routing
@tanstack/react-query           # Data fetching + caching
tailwindcss @tailwindcss/vite   # Styling (v4)
clsx tailwind-merge             # Class name utilities
lucide-react                    # Icons
```

shadcn/ui components are copied into `src/components/ui/` (not an npm dependency).

### Server package

```
@fastify/static                 # Serve web dist static files
```

---

## 9. Implementation Steps

### Step 0: Server API Prefix + Static Hosting

**Package:** `@agent-hub/server`

**Changes:**

| File | Change |
|------|--------|
| `src/app.ts` | Wrap all route registrations under `{ prefix: "/api" }`; add `@fastify/static` for web dist; add SPA fallback in notFoundHandler |
| `src/config.ts` | Add optional `WEB_DIST_PATH` env var |
| `src/__tests__/**` | Update all API paths in tests to include `/api` prefix |
| `package.json` | Add `@fastify/static` dependency |

**Validation:** `pnpm check && pnpm typecheck && pnpm test`

### Step 1: Web Infrastructure

**Package:** `@agent-hub/web`

**Changes:**

| File | Change |
|------|--------|
| `package.json` | Add new dependencies |
| `vite.config.ts` | Add Tailwind plugin + dev proxy (`/api` → `localhost:8000`) |
| `src/main.tsx` | Mount App with providers |
| `src/app.tsx` | New — Router + QueryClient + AuthProvider composition |
| `src/lib/utils.ts` | New — `cn()` helper |
| `src/components/ui/*` | New — shadcn/ui base components (button, input, card, etc.) |
| `tailwind.config.ts` or `src/index.css` | Tailwind v4 theme config |

### Step 2: API Client + Auth

**Package:** `@agent-hub/web`

**Changes:**

| File | Change |
|------|--------|
| `src/api/client.ts` | New — fetch wrapper with auth + refresh |
| `src/api/auth.ts` | New — login(), refreshToken() |
| `src/auth/auth-context.tsx` | New — AuthContext + AuthProvider |
| `src/auth/require-auth.tsx` | New — route guard |
| `src/pages/login.tsx` | New — login page |

### Step 3: Layout + Overview

**Package:** `@agent-hub/web`

**Changes:**

| File | Change |
|------|--------|
| `src/components/layout.tsx` | New — sidebar + top bar layout |
| `src/api/overview.ts` | New — getOverview() |
| `src/pages/overview.tsx` | New — dashboard with stat cards |

### Step 4: Agent Management

**Package:** `@agent-hub/web`

**Changes:**

| File | Change |
|------|--------|
| `src/api/agents.ts` | New — agent CRUD API calls |
| `src/api/tokens.ts` | New — token management API calls |
| `src/pages/agents.tsx` | New — agent list (table + pagination + create dialog) |
| `src/pages/agent-detail.tsx` | New — agent info edit + token management |
| `src/components/ui/*` | New — table, dialog, badge components as needed |

### Step 5: System Config

**Package:** `@agent-hub/web`

**Changes:**

| File | Change |
|------|--------|
| `src/api/system-config.ts` | New — getConfigs(), updateConfigs() |
| `src/pages/settings.tsx` | New — key-value config edit form |

---

## 10. Vite Configuration

```typescript
// packages/web/vite.config.ts
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": "http://localhost:8000",
    },
  },
});
```

---

## 11. Build & Turborepo

Update `turbo.json` to ensure web builds before server (server needs web's dist):

```jsonc
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],  // already present — web builds first
      "outputs": ["dist/**"]
    }
  }
}
```

No structural changes needed; Turborepo's `^build` already handles dependency ordering since server doesn't depend on web at source level. The static file path is resolved at runtime.
