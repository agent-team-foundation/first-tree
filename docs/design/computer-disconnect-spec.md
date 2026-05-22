# Computer Disconnect Awareness — Technical Spec

**Status:** ready for implementation
**UI preview:** `docs/design/computer-disconnect-preview.html`
**Owner:** YueZengwu
**Date:** 2026-04-29

---

## 1. Problem

When the local computer (a First Tree Hub Client process) loses its WebSocket connection, every agent pinned to that computer goes offline. The product surface gives no prominent signal — the user only finds out when an agent fails to respond. The Computers page (`/clients`) is the place to recover, but the user has no reason to visit it until they already notice things are broken.

## 2. Goals

| # | Goal |
|---|---|
| G1 | A persistent, **prominent** topbar warning whenever the **caller's own** Client process is disconnected and still has agents bound to it. |
| G2 | One-click jump from the warning to the Computers page so the user can fix the connection. |
| G3 | Replace the embedded "Connect a computer" strip with an explicit `New Connection +` button that opens a modal mirroring the OnboardingModal flow (token + waiting state + auto-detect). |

## 3. Non-goals

- No new WebSocket events, no realtime push. The existing 10s polling on `["clients"]` is the freshness budget.
- No backend schema change, no new API endpoints.
- The `OnboardingModal` first-run wizard is **not touched** — it continues to greet brand-new accounts. The new dialog is a separate surface for the steady state.
- Cross-member visibility is out of scope: even an admin only sees their own disconnected machines in the topbar chip.

## 4. UX summary

Reflected in detail by `computer-disconnect-preview.html`. Headlines:

- **Topbar chip** — sits inside the brand cluster (right of `First Tree Hub`). Pulsing red dot + text. No icon. Hostname truncates at 160px with ellipsis; full name in the `title` tooltip.
- **Copy** — single: `<host> disconnected`; multi: `<n> computers disconnected`.
- **Trigger** — one or more clients owned by the current user with `status="disconnected"` AND `agentCount > 0`.
- **Click target** — `navigate("/clients")`.
- **Tab centring** — topbar grid changes from `auto 1fr auto` to `1fr auto 1fr`. Tabs sit in the centre `auto` column; left and right `1fr` columns absorb growth so tabs stay anchored to the page midpoint regardless of chip presence or future additions.
- **`New Connection +` button** — primary CTA, right-aligned above the registered table, replacing the entire `ConnectStrip` row.
- **Dialog** — title + description, generated command in mono code block, `Copy` button, `Cancel` ghost button. Initially shows yellow `Waiting for your computer to connect…` row. On detection, swaps to green success row, briefly holds (~1.2s), auto-closes, refetches the table.

## 5. Architecture

### 5.1 Data sources (existing, unchanged)

| Endpoint | Purpose | Existing polling |
|---|---|---|
| `GET /api/v1/clients` | List of `HubClient` rows visible to the caller, including `status`, `agentCount`, `userId` | 10s `refetchInterval` from `pages/clients.tsx` |
| `POST /api/v1/connect-tokens` | Mints a single-use connect token + ready-made command string | n/a |

The topbar chip and the new dialog **both** consume the same `["clients"]` query. We enable that query from `Layout` via the React Query hook so it refetches once (10s cadence) for the whole app, regardless of which page is active.

### 5.2 Trigger logic (frontend-only)

```
disconnected = clients.filter(c =>
   c.userId === currentUser.id &&    // strictly caller's own — admin role does not widen this
   c.status === "disconnected" &&
   c.agentCount > 0
)

show chip          ← disconnected.length >= 1
copy single        ← `${disconnected[0].hostname ?? "computer"} disconnected`
copy multi (n>=2)  ← `${disconnected.length} computers disconnected`
```

`currentUser.id` comes from `useAuth()` → `user.id`. If `user` is null (auth context still warming up) the chip stays hidden.

### 5.3 Failure mode

Up to 10s lag between the WS close and the chip appearing — acceptable for "your computer is gone, please reconnect." If we ever want sub-second feedback, the follow-up is a `client:state` payload broadcast through the existing `broadcastToAdmins` seam (out of scope here).

---

## 6. Frontend change set

### 6.1 New: `packages/web/src/hooks/use-disconnected-computers.ts`

A small hook wrapping the existing `["clients"]` query so both the Layout and the Computers page consume the same cache entry. Returns the filtered list and prefetches it from `Layout` even when the user is not on `/clients`.

```ts
import { useQuery } from "@tanstack/react-query";
import { listClients, type HubClient } from "../api/activity.js";
import { useAuth } from "../auth/auth-context.js";

export function useDisconnectedComputers(): { rows: HubClient[]; firstHostname: string | null } {
  const { user } = useAuth();
  const { data } = useQuery({
    queryKey: ["clients"],
    queryFn: listClients,
    refetchInterval: 10_000,
    enabled: !!user,
  });
  if (!data || !user) return { rows: [], firstHostname: null };
  const rows = data.filter((c) => c.userId === user.id && c.status === "disconnected" && c.agentCount > 0);
  return { rows, firstHostname: rows[0]?.hostname ?? null };
}
```

The hook is thin on purpose — it is only the chip's read path and a place to keep the filter rule in one spot. The dialog and the Computers page already use the same query directly, so they automatically share the cache.

### 6.2 New: `packages/web/src/components/disconnect-chip.tsx`

The chip itself. ~50 lines. Uses the shared `StateDot` styling pattern (solid circle + ring-pulse) but inlined — `StateDot.error` is a triangle, not a pulsing dot, so we don't reuse it directly. The pulse keyframe (`ring-pulse`) is already defined in `index.css` and used by `StateDot.working`; we reuse the keyframe and just swap the colour.

```tsx
import { useNavigate } from "react-router";
import { useDisconnectedComputers } from "../hooks/use-disconnected-computers.js";

const HOSTNAME_MAX_PX = 160;

export function DisconnectChip() {
  const navigate = useNavigate();
  const { rows, firstHostname } = useDisconnectedComputers();
  if (rows.length === 0) return null;

  const fullTitle =
    rows.length === 1
      ? `${firstHostname ?? "Your computer"} is disconnected. Click to manage.`
      : `${rows.length} computers disconnected. Click to manage.`;

  return (
    <button
      type="button"
      onClick={() => navigate("/clients")}
      title={fullTitle}
      className="inline-flex items-center cursor-pointer"
      style={{
        gap: 8,
        height: 26,
        padding: "0 10px 0 9px",
        borderRadius: 999,
        fontSize: 12.5,
        fontWeight: 500,
        letterSpacing: "-0.1px",
        border: 0,
        outline: "var(--hairline) solid color-mix(in oklch, var(--state-error) 38%, transparent)",
        outlineOffset: -1,
        background: "color-mix(in oklch, var(--state-error) 14%, transparent)",
        color: "color-mix(in oklch, var(--state-error) 80%, var(--fg))",
      }}
    >
      <PulseDot />
      {rows.length === 1 ? (
        <span className="inline-flex items-center" style={{ gap: 5, minWidth: 0 }}>
          <span
            className="mono"
            style={{
              fontSize: 12,
              fontWeight: 500,
              maxWidth: HOSTNAME_MAX_PX,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "color-mix(in oklch, var(--state-error) 60%, var(--fg))",
            }}
          >
            {firstHostname ?? "computer"}
          </span>
          <span style={{ flexShrink: 0 }}>disconnected</span>
        </span>
      ) : (
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          <strong style={{ fontWeight: 600 }}>{rows.length}</strong> computers disconnected
        </span>
      )}
    </button>
  );
}

function PulseDot() {
  return (
    <span aria-hidden="true" style={{ position: "relative", width: 8, height: 8, flexShrink: 0, display: "inline-block" }}>
      <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: "var(--state-error)" }} />
      <span
        style={{
          position: "absolute",
          inset: -3,
          borderRadius: "50%",
          border: "var(--hairline) solid var(--state-error)",
          animation: "ring-pulse 1.8s infinite",
          opacity: 0.6,
        }}
      />
    </span>
  );
}
```

### 6.3 Edit: `packages/web/src/components/layout.tsx`

Two changes:

1. **Grid columns** `auto 1fr auto` → `1fr auto 1fr`. Brand cluster is `justify-self: start`; tabs `justify-self: center`; right controls `justify-self: end`. This locks tab centring to the page midpoint.
2. **Wrap brand + chip in a flex cluster.** Add the new `DisconnectChip` immediately right of the brand `<span>`.

Diff against `layout.tsx:46-66`:

```diff
       <header
         className="relative shrink-0 grid items-center"
         style={{
           height: 48,
-          gridTemplateColumns: "auto 1fr auto",
+          gridTemplateColumns: "1fr auto 1fr",
+          gap: 12,
           padding: "0 var(--sp-3)",
           borderBottom: "var(--hairline) solid var(--border)",
           background: "var(--bg-raised)",
         }}
       >
-        {/* Brand */}
-        <div className="flex items-center" style={{ gap: 10 }}>
-          <FirstTreeLogo width={16} height={18} style={{ color: "var(--fg)" }} />
-          <span className="text-title" style={{ color: "var(--fg)" }}>
-            First Tree{" "}
-            <span className="font-normal" style={{ color: "var(--fg-3)" }}>
-              Hub
-            </span>
-          </span>
-        </div>
+        {/* Brand cluster */}
+        <div className="flex items-center" style={{ gap: 14, justifySelf: "start", minWidth: 0 }}>
+          <span className="flex items-center" style={{ gap: 10, flexShrink: 0 }}>
+            <FirstTreeLogo width={16} height={18} style={{ color: "var(--fg)" }} />
+            <span className="text-title" style={{ color: "var(--fg)" }}>
+              First Tree{" "}
+              <span className="font-normal" style={{ color: "var(--fg-3)" }}>
+                Hub
+              </span>
+            </span>
+          </span>
+          <DisconnectChip />
+        </div>
```

The existing `pointerEvents: "none"` trick on the tabs `<nav>` (line 69) stays; tabs add `style={{ justifySelf: "center" }}` and the right-controls block adds `justifySelf: "end"` so the grid columns settle predictably.

### 6.4 New: `packages/web/src/pages/clients/new-connection-dialog.tsx`

Co-located under a new `pages/clients/` folder so `clients.tsx` shrinks. The dialog wraps the existing Radix `Dialog` primitive (`components/ui/dialog.tsx`).

Behaviour outline:

```tsx
type Phase = "loading" | "waiting" | "success";

const POLL_MS = 3_000;
const SUCCESS_HOLD_MS = 1_200;

export function NewConnectionDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (next: boolean) => void }) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>("loading");
  const [token, setToken] = useState<ConnectTokenResponse | null>(null);
  const [newHostname, setNewHostname] = useState<string | null>(null);
  const baselineRef = useRef<Set<string>>(new Set());

  // 1. On open: snapshot current clientIds, mint a token.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPhase("loading");
    setToken(null);
    setNewHostname(null);

    (async () => {
      const existing = (queryClient.getQueryData<HubClient[]>(["clients"]) ?? []).map((c) => c.id);
      baselineRef.current = new Set(existing);
      try {
        const t = await generateConnectToken();
        if (!cancelled) {
          setToken(t);
          setPhase("waiting");
        }
      } catch {
        // surface inline; user can cancel + retry
      }
    })();

    return () => { cancelled = true; };
  }, [open, queryClient]);

  // 2. While waiting: poll /clients every 3s, watch for a new id with status=connected.
  useEffect(() => {
    if (!open || phase !== "waiting") return;
    const tick = async () => {
      const fresh = await queryClient.fetchQuery({ queryKey: ["clients"], queryFn: listClients });
      const baseline = baselineRef.current;
      const arrived = fresh.find((c) => !baseline.has(c.id) && c.status === "connected");
      if (arrived) {
        setNewHostname(arrived.hostname ?? null);
        setPhase("success");
      }
    };
    const handle = setInterval(tick, POLL_MS);
    return () => clearInterval(handle);
  }, [open, phase, queryClient]);

  // 3. On success: brief hold, then close.
  useEffect(() => {
    if (phase !== "success") return;
    const handle = setTimeout(() => onOpenChange(false), SUCCESS_HOLD_MS);
    return () => clearTimeout(handle);
  }, [phase, onOpenChange]);

  // … render: title/desc, mono command + Copy button, waiting/success row, Cancel.
}
```

Notes:
- The dialog **does not** consume the running `["clients"]` query from `useQuery` — it calls `queryClient.fetchQuery` on its own 3s tick to keep its faster cadence isolated. The shared 10s `refetchInterval` continues independently; both routes write into the same cache so the table refresh is free.
- `baselineRef` snapshots **all** client ids (regardless of status), so a previously-known computer that reconnects does **not** falsely close the dialog. Only a brand-new id with `status="connected"` triggers success.
- If the user closes the dialog before a new client appears, the unused token simply expires server-side (TTL is the existing `connect-tokens` setting; nothing to clean up).

### 6.5 Edit: `packages/web/src/pages/clients.tsx`

1. **Delete** the entire `ConnectStrip` function and its render call (`clients.tsx:41-104, 182`).
2. **Add** a `New Connection +` button in its place, right-aligned above the table:

```tsx
<div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "var(--sp-3_5)" }}>
  <Button onClick={() => setNewConnectionOpen(true)}>
    <Plus className="h-3.5 w-3.5" /> New Connection
  </Button>
</div>

<NewConnectionDialog open={newConnectionOpen} onOpenChange={setNewConnectionOpen} />
```

3. **Drop** the `Terminal`, `Copy`, `Check` imports from `lucide-react` if no longer used elsewhere in this file. Add `Plus`.
4. **Drop** the unused `generateConnectToken` and `ConnectTokenResponse` imports from `../api/activity.js` (now used only inside the dialog).
5. The table's empty-state copy `No computers. Use the button above to generate a connect command.` stays — it points at the new button.

---

## 7. Backend

**No changes.** All four touch-points already exist:

- `GET /api/v1/clients` (`packages/server/src/api/admin/clients.ts:18-36`)
- `POST /api/v1/connect-tokens` (`packages/server/src/api/me.ts:97-112`)
- `clients.status` flips to `"disconnected"` in the WS close handler (`packages/server/src/api/agent/ws-client.ts:594-601`)
- The existing 10s React Query poll is the freshness mechanism

If we later move to push-based updates, the seam is `broadcastToAdmins({ type: "client:state", clientId, status, organizationId })` from `clients.ts`'s register/disconnect paths — but that is explicitly out of scope.

---

## 8. Edge cases

| Case | Behaviour |
|---|---|
| User has 0 clients | Chip hidden. New Connection button reachable from the (now empty) Computers page. |
| User has only `agentCount === 0` clients, all disconnected | Chip hidden. Computers page table still shows them with `offline` status — they can disconnect/retire from there. |
| Multiple disconnected (single user) | Multi copy: `2 computers disconnected`. Click → `/clients`. |
| Admin viewing teammate's offline computer | No chip — filter is strictly `userId === user.id`. Admin still sees the row in the table because `listClients` returns org-scoped data for admin role. |
| `user` is null (auth warming up) | Hook returns `rows: []`, chip hidden. |
| Hostname is null | Chip falls back to `"computer disconnected"` (drop the leading mono span). |
| Hostname is 80 chars | Truncates at `max-width: 160px` with ellipsis; full name in `title` tooltip. |
| Dialog closed before reconnect | Token sits unused, expires on its existing TTL. No client-side state to clean up. |
| Dialog open while a *different* computer reconnects | New computer satisfies the `!baseline.has(id) && status==="connected"` test → success closes. This is the intended behaviour: the user wanted *a* computer connected; they got one. |
| User cancels while polling | `setInterval` cleared via the cleanup return in the effect — no leaking timer. |
| Network error on `POST /connect-tokens` | Phase stays at `loading`. Inline error row to be added; Cancel still closes the dialog. |

---

## 9. Test plan

### 9.1 Type + lint
- `pnpm check && pnpm typecheck` after every edit.

### 9.2 Manual verification (against an isolated `FIRST_TREE_HOME` per CLAUDE.md)

1. Start the hub + web server. Connect one client. Confirm topbar shows no chip.
2. Pin an agent to that client. Kill the client process (`pkill -f first-tree`).
3. Within ~10s, the topbar chip appears with `<host> disconnected`. Verify pulsing dot animates.
4. Click the chip — should land on `/clients`. Verify the row's `Status` cell reads `offline`.
5. Reconnect the client. Within ~10s the chip disappears.
6. Pin a second agent on a second machine; disconnect both. Confirm chip reads `2 computers disconnected`.
7. Click `New Connection +` on `/clients`. The modal opens with the command inline + yellow `Waiting…` row. Run the command on a fresh machine. The modal flips to green, says `<host> connected. Closing…`, auto-closes within ~1.2s, and the table refreshes to show the new row.
8. Repeat (7) but cancel before the client connects — modal closes cleanly, no errors in console.

### 9.3 Visual regression
Cross-check against `docs/design/computer-disconnect-preview.html`:
- A: single chip + tabs centred (against guide line)
- A2: long hostname truncates with ellipsis
- B: multi-count chip + tabs still centred
- C: no chip + tabs in identical centre position
- D: ConnectStrip absent, New Connection button present
- E/F: dialog yellow→green transition

### 9.4 Unit tests (additive, not blocking)
- `use-disconnected-computers.test.tsx` — filter rule: respects `userId === current`, status === disconnected, agentCount > 0; returns empty when user is null.
- `disconnect-chip.test.tsx` — copy switches at n=1 vs n>=2; click invokes `navigate("/clients")`; truncation applies via `title` attr.

The existing `clients.test.tsx` (if any) needs updating to drop ConnectStrip assertions and add `New Connection` button + dialog mount checks.

---

## 10. Out of scope / follow-ups

- **Realtime push** of client connect/disconnect via `broadcastToAdmins`. The current 10s lag is acceptable; we can add this when it becomes a clear pain point.
- **Cross-member visibility** for admins (e.g. "3 of your team's computers are offline"). Possible future feature but explicitly excluded here per decision F.
- **Highlighting the offending row** when arriving at `/clients` from the chip (e.g. `?focus=<id>` query param). Listed as a nice-to-have in the preview doc; deferred so this PR stays scoped.
- **Auth-method-specific reconnect hints** (e.g. SDK missing → install hint inline in the chip popover). The expanded row's CapabilityMatrix already covers this once the user is on `/clients`.

---

## 11. File-by-file change summary

| File | Action | Notes |
|---|---|---|
| `packages/web/src/hooks/use-disconnected-computers.ts` | **new** | shared filter rule + cache-friendly read |
| `packages/web/src/components/disconnect-chip.tsx` | **new** | the topbar chip |
| `packages/web/src/components/layout.tsx` | edit | grid `auto 1fr auto` → `1fr auto 1fr`; mount `<DisconnectChip />` next to brand |
| `packages/web/src/pages/clients/new-connection-dialog.tsx` | **new** | the modal flow |
| `packages/web/src/pages/clients.tsx` | edit | remove `ConnectStrip`; add `New Connection +` button + `<NewConnectionDialog />` |
| `docs/design/computer-disconnect-preview.html` | **new (already landed)** | design preview, referenced from the PR description |
| `docs/design/computer-disconnect-spec.md` | **new (this file)** | the technical spec |

Total: 4 edits, 4 new files (2 of which are docs). No backend, no shared schema, no DB migration.
