import { parseWorkspaceDocKey } from "@first-tree/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Components } from "react-markdown";
import { useSearchParams } from "react-router";
import { getMeDoc } from "../api/me-docs.js";
import { docPreviewPathFromHref } from "../lib/doc-preview-links.js";
import { useAgentSlugToIdMap } from "../lib/use-agent-name-map.js";
import { cn } from "../lib/utils.js";
import { type DocSnapshotEntry, docSnapshotQueryKey } from "../pages/workspace/center/chat-view.js";
import { Button } from "./ui/button.js";
import { Markdown } from "./ui/markdown.js";

const DEFAULT_MAX_WIDTH = 1200;
const DEFAULT_VIEWPORT_RATIO = 0.55;
const MIN_DRAWER_WIDTH = 360;
/**
 * Reserved layout width the drawer must NOT eat into when it expands.
 * Covers the fixed left conversation rail (320 wide, see
 * `packages/web/src/pages/workspace/conversations/index.tsx`) plus the
 * minimum readable chat column (about 320). Without this the drawer can
 * drag itself wide enough to squash the chat composer / reading column
 * into a few characters per line on common laptop viewports.
 */
const RESERVED_MAIN_WIDTH = 640;
const RESIZE_KEY_STEP = 24;
const WIDTH_STORAGE_KEY = "first-tree:doc-preview-drawer:width:v1";

function defaultDrawerWidth(): number {
  if (typeof window === "undefined") return DEFAULT_MAX_WIDTH;
  return Math.max(
    MIN_DRAWER_WIDTH,
    Math.min(DEFAULT_MAX_WIDTH, Math.round(window.innerWidth * DEFAULT_VIEWPORT_RATIO)),
  );
}

function clampDrawerWidth(width: number): number {
  if (typeof window === "undefined") return Math.max(MIN_DRAWER_WIDTH, width);
  const maxWidth = Math.max(MIN_DRAWER_WIDTH, window.innerWidth - RESERVED_MAIN_WIDTH);
  return Math.min(Math.max(width, MIN_DRAWER_WIDTH), maxWidth);
}

function loadPersistedWidth(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(WIDTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function savePersistedWidth(width: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
  } catch {
    // localStorage may be unavailable (private mode, disk quota); silently ignore.
  }
}

function useIsMobileDocPreview(): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia("(max-width: 47.999rem)").matches,
  );

  useEffect(() => {
    const media = window.matchMedia("(max-width: 47.999rem)");
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return isMobile;
}

/**
 * Markdown preview rail that sits to the right of the chat reading column.
 *
 * Layout:
 *   - Desktop: a `relative shrink-0` flex sibling inside chat-view's flex
 *     container. The chat main column flexes around it, so the drawer
 *     coexists with the chat instead of overlaying it. The left edge is
 *     a draggable col-resize handle (mouse + keyboard via Arrow Left /
 *     Right) so the user can widen or shrink the rail toward the chat
 *     main column.
 *   - Mobile (`max-width: 47.999rem`): full-screen fixed inset-0 modal
 *     with focus trap, so the same component covers both surfaces
 *     without rendering two competing rails on a narrow viewport.
 *
 * Data source priority:
 *   - Inline snapshot via React Query cache (PR 415). chat-view seeds the
 *     whole message's `docs[]` when the user clicks any `.md` link, so
 *     opening the drawer is a synchronous cache read with no network
 *     round-trip — load-bearing on the cloud topology where the server
 *     cannot read the local agent workspace.
 *   - Falls back to `GET /me/docs/preview` (path variant) when no inline
 *     snapshot is attached. Useful for single-host deployments where the
 *     server can still read workspace files directly.
 *
 * Slot semantics — the drawer is rendered by chat-view in the same right
 * slot as `<ChatRightSidebar>`. chat-view enforces mutual exclusion so the
 * two rails never compete for space; see `chat-view.tsx` for the slot
 * decision and the auto-restore behaviour that re-opens the sidebar when
 * the drawer closes.
 */
export function DocPreviewDrawer() {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const docChatId = searchParams.get("docChat");
  const docAgentId = searchParams.get("docAgent");
  const docPath = searchParams.get("docPath");
  const docBasePath = searchParams.get("docBase") ?? undefined;
  const docMsgId = searchParams.get("docMsg");
  const hasDocRef = Boolean(docChatId && docAgentId && docPath);
  // Inline snapshot takes precedence: when the chat-view click handler tagged
  // the URL with `docMsg`, it also seeded the React Query cache under
  // `docSnapshotQueryKey` so we can render the markdown straight from
  // memory without hitting the legacy path-based endpoint.
  const inlineSnapshot =
    docMsgId && docChatId && docPath
      ? queryClient.getQueryData<DocSnapshotEntry>(docSnapshotQueryKey(docChatId, docMsgId, docPath))
      : undefined;
  const isMobile = useIsMobileDocPreview();
  const [drawerWidth, setDrawerWidth] = useState<number>(() =>
    clampDrawerWidth(loadPersistedWidth() ?? defaultDrawerWidth()),
  );
  const drawerRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Persist width changes (skip mobile — width has no meaning when the
  // drawer is a fullscreen modal and we don't want a portrait-mode
  // session to overwrite the user's desktop width preference).
  useEffect(() => {
    if (isMobile) return;
    savePersistedWidth(drawerWidth);
  }, [isMobile, drawerWidth]);

  // Re-clamp when the viewport shrinks below the saved width (e.g. window
  // resize, devtools open). Without this the drawer could end up wider
  // than the viewport - RESERVED_MAIN_WIDTH and squeeze the chat column
  // below usable size.
  useEffect(() => {
    if (isMobile) return;
    const onResize = () => setDrawerWidth((current) => clampDrawerWidth(current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [isMobile]);

  const close = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete("docChat");
    next.delete("docAgent");
    next.delete("docPath");
    next.delete("docBase");
    next.delete("docMsg");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (!hasDocRef) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close, hasDocRef]);

  useEffect(() => {
    if (!hasDocRef || !isMobile) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);

    return () => {
      window.clearTimeout(focusTimer);
      const previous = previousFocusRef.current;
      previousFocusRef.current = null;
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [hasDocRef, isMobile]);

  // A cross-agent docPath is a global key `<ownerSlug>/<chatId>/<rel>`; the
  // path-based fallback endpoint is keyed by (owner agentId, rel) under
  // `workspaces/<ownerName>/<chatId>/`, so strip the owner+chatId prefix and
  // send just `rel`. Self / legacy bare keys (or a deep self path whose chatId
  // segment doesn't match this chat) pass through unchanged.
  const slugToId = useAgentSlugToIdMap();
  const parsedKey = docPath ? parseWorkspaceDocKey(docPath) : null;
  const isCrossKey = parsedKey !== null && parsedKey.chatId === docChatId;
  // For a cross key the OWNER is named in the key itself — resolve the owner
  // agent id from that slug rather than trusting `docAgent` (the click handler
  // may have stored the sender as a hasDocRef placeholder when the owner slug
  // couldn't be resolved). This keeps the fallback pointed at the owner's
  // workspace even after a reload / cache miss; if the owner can't be resolved
  // we DISABLE the fallback rather than query the sender, which could surface a
  // same-named file from the WRONG workspace (review P2-a).
  const crossOwnerId = isCrossKey && parsedKey ? slugToId(parsedKey.agentSlug) : null;
  const fallbackAgentId = isCrossKey ? crossOwnerId : docAgentId;
  const apiPath = isCrossKey && parsedKey ? parsedKey.rel : (docPath ?? "");
  const apiBasePath = isCrossKey ? undefined : docBasePath;
  const previewQuery = useQuery({
    queryKey: ["me", "docs", "preview", docChatId, fallbackAgentId, apiBasePath, apiPath],
    queryFn: () =>
      getMeDoc(docChatId ?? "", {
        agentId: fallbackAgentId ?? "",
        basePath: apiBasePath,
        path: apiPath,
      }),
    // Skip the network round-trip when we already have an inline snapshot
    // pre-staged in the React Query cache — see chat-view click handler. Also
    // skip for a cross key whose owner couldn't be resolved (fail closed).
    enabled: hasDocRef && !inlineSnapshot && Boolean(fallbackAgentId),
  });
  const resolvedDocPath = inlineSnapshot?.path ?? previewQuery.data?.ref.path ?? docPath;
  const displayDocPath = inlineSnapshot?.path ?? previewQuery.data?.path ?? docPath;

  const title = useMemo(() => {
    const path = displayDocPath ?? "";
    return path.split("/").filter(Boolean).at(-1) ?? path;
  }, [displayDocPath]);
  const subtitle = displayDocPath && displayDocPath !== title ? displayDocPath : null;

  const openDocPath = useCallback(
    (path: string) => {
      const next = new URLSearchParams(searchParams);
      next.set("docPath", path);
      setSearchParams(next);
    },
    [searchParams, setSearchParams],
  );

  const markdownComponents = useMemo<Components>(
    () => ({
      a({ href, children, ...props }) {
        const onClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
          if (
            !href ||
            event.defaultPrevented ||
            event.button !== 0 ||
            event.metaKey ||
            event.altKey ||
            event.ctrlKey ||
            event.shiftKey
          ) {
            return;
          }
          const nextDocPath = docPreviewPathFromHref(href, resolvedDocPath);
          if (!nextDocPath) return;
          event.preventDefault();
          openDocPath(nextDocPath);
        };

        return (
          <a {...props} href={href} onClick={onClick} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      },
    }),
    [openDocPath, resolvedDocPath],
  );

  // Resize via the left edge. The drawer lives on the right of the chat
  // main column, so growing left = wider drawer (= narrower chat). Track
  // the starting width at mousedown and apply (startX - clientX) to the
  // delta so cumulative drags stay stable across React state updates.
  const startResize = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    let startWidth: number | null = null;
    const onMouseMove = (moveEvent: MouseEvent) => {
      setDrawerWidth((current) => {
        if (startWidth === null) startWidth = current;
        return clampDrawerWidth(startWidth + (startX - moveEvent.clientX));
      });
    };
    const onMouseUp = () => {
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, []);

  // Keyboard a11y for the resize handle. Arrow Left widens the drawer
  // (it lives on the right, so "left" means "push the resize edge
  // leftward into the chat column"); Arrow Right narrows it.
  const resizeWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setDrawerWidth((current) => clampDrawerWidth(current + RESIZE_KEY_STEP));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setDrawerWidth((current) => clampDrawerWidth(current - RESIZE_KEY_STEP));
    }
  }, []);

  const trapMobileFocus = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (!isMobile || event.key !== "Tab") return;
      const focusable = Array.from(
        drawerRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true");

      const first = focusable.at(0);
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [isMobile],
  );

  if (!hasDocRef) return null;

  return (
    <aside
      aria-label="Document preview"
      aria-modal={isMobile}
      data-doc-preview-drawer=""
      className={cn(
        "z-40 flex flex-col bg-card text-foreground",
        "animate-in slide-in-from-right duration-200",
        isMobile
          ? "fixed inset-0 w-full border-l border-border"
          : "relative h-auto shrink-0 overflow-hidden border-l border-border-faint max-w-[calc(100vw-var(--sp-8))]",
      )}
      onKeyDown={trapMobileFocus}
      ref={drawerRef}
      role="dialog"
      style={isMobile ? undefined : { width: drawerWidth }}
    >
      {isMobile ? null : (
        <button
          aria-label="Resize document preview"
          className="group absolute top-0 left-0 z-10 h-full w-3 -translate-x-1/2 cursor-col-resize"
          onMouseDown={startResize}
          onKeyDown={resizeWithKeyboard}
          type="button"
        >
          {/* Always-on hairline so the user can see the rail is draggable.
              Hover bumps to full opacity for affirmative feedback. */}
          <div className="mx-auto h-full w-px bg-border-faint opacity-60 transition-all group-hover:w-1 group-hover:bg-accent group-hover:opacity-100" />
        </button>
      )}

      <header
        className="flex shrink-0 items-center gap-3 px-4"
        // Match chat-view's header sizing + raised background so the two
        // headers share one continuous chrome row across the panel split.
        style={{ height: 52, background: "var(--bg-raised)" }}
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-body font-medium">{title}</div>
          {subtitle ? <div className="truncate text-caption text-fg-3">{subtitle}</div> : null}
        </div>
        <Button
          aria-label="Close document preview"
          onClick={close}
          ref={closeButtonRef}
          size="icon"
          type="button"
          variant="ghost"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {inlineSnapshot ? (
          <Markdown components={markdownComponents}>{inlineSnapshot.content}</Markdown>
        ) : (
          <>
            {previewQuery.isLoading ? (
              <div className="flex h-full items-center justify-center text-body text-fg-2">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                Loading preview
              </div>
            ) : null}

            {previewQuery.isError ? (
              <div className="rounded-[var(--radius-panel)] border border-error bg-error-soft p-4 text-body text-error">
                {previewQuery.error instanceof Error ? previewQuery.error.message : "Unable to load document"}
              </div>
            ) : null}

            {previewQuery.data ? (
              <Markdown components={markdownComponents}>{previewQuery.data.content}</Markdown>
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}
