---
title: "Web Admin Console"
owners: [baixiaohang]
soft_links: []
---

# Web Admin Console

Browser-based management interface for Agent Hub administrators. Consumes the Admin API (JWT-authenticated).

---

## Scope

| Page | Purpose | Key Features |
|------|---------|-------------|
| **Login** | Admin authentication | Username/password → JWT |
| **Overview** | System dashboard | Agent count, online count, chat count |
| **Agents** | Agent management | List with status/type filters, sync trigger, agent detail (info, tokens, presence, bindings) |
| **Chats** | Chat browser | Chat list, message history (read-only, for ops/audit) |
| **Bindings** | Adapter identity mappings | View/create/delete external user ↔ agent mappings |
| **Admin Users** | Admin account management | CRUD admin accounts, role assignment |
| **Settings** | System configuration | Runtime parameters (timeouts, polling intervals, Context Tree config) |

---

## Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Framework | React 19 + Vite | SPA sufficient for admin console |
| Routing | React Router v7 | Standard SPA routing |
| Styling | Tailwind CSS v4 | Utility-first, consistent with other frontends |
| UI Components | shadcn/ui (Radix + Tailwind) | In-project components; admin-friendly (Table/Form/Dialog) |
| Data Fetching | TanStack Query v5 | Caching, loading states, auto-refetch |
| Auth State | React Context | Sufficient scale for admin console |

---

## Deployment Model

### Production: Embedded in Server

```
            https://hub.example.com
                      │
            ┌─────────────────────┐
            │  first-tree-hub      │
            │  server              │
            │                     │
            │  /api/*  → API      │
            │  /web/*  → Web SPA  │
            └──────────┬──────────┘
                       │
                  PostgreSQL
```

- `pnpm build` compiles Web into static files.
- Server serves them via `@fastify/static`.
- Single port, single process, single domain — no CORS needed.

### Development: Separate Processes

```
Terminal 1: pnpm --filter @first-tree-hub/server dev     → API on :8000
Terminal 2: pnpm --filter @first-tree-hub/web dev        → Vite on :5173, proxies /api → :8000
```

---

## Auth Flow

1. Admin submits username/password → `POST /api/v1/admin/auth/login` → receives JWT.
2. JWT stored in localStorage. Injected as `Authorization: Bearer` on all API calls.
3. On 401: attempt token refresh → if refresh fails, redirect to login.
4. Route guard: unauthenticated users redirected to `/login`.

**Why localStorage over httpOnly cookies:** The console is a pure SPA with no server-side session layer. localStorage is chosen because the deployment is private (not multi-tenant) and the admin surface is small — no user-generated content is rendered.
