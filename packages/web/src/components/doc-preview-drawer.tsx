import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GripHorizontal, Loader2, X } from "lucide-react";
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
import { cn } from "../lib/utils.js";
import { type DocSnapshotEntry, docSnapshotQueryKey } from "../pages/workspace/center/chat-view.js";
import { Button } from "./ui/button.js";
import { Markdown } from "./ui/markdown.js";

const DEFAULT_MAX_WIDTH = 720;
const DEFAULT_VIEWPORT_RATIO = 0.45;
const MIN_DRAWER_WIDTH = 360;
const MIN_DRAWER_HEIGHT = 280;
const DEFAULT_TOP = 80;
const DEFAULT_RIGHT_GAP = 24;
const RESIZE_KEY_STEP = 24;
const SCREEN_PADDING = 8;
const RECT_STORAGE_KEY = "first-tree-hub:doc-preview-drawer:v1";

type FloatingRect = { top: number; left: number; width: number; height: number };

function defaultDrawerWidth(): number {
  if (typeof window === "undefined") return DEFAULT_MAX_WIDTH;
  return Math.max(
    MIN_DRAWER_WIDTH,
    Math.min(DEFAULT_MAX_WIDTH, Math.round(window.innerWidth * DEFAULT_VIEWPORT_RATIO)),
  );
}

function defaultRect(): FloatingRect {
  const width = defaultDrawerWidth();
  if (typeof window === "undefined") {
    return { top: DEFAULT_TOP, left: 320, width, height: 540 };
  }
  const height = Math.min(640, Math.max(MIN_DRAWER_HEIGHT, Math.round(window.innerHeight * 0.72)));
  const left = Math.max(SCREEN_PADDING, window.innerWidth - width - DEFAULT_RIGHT_GAP);
  return { top: DEFAULT_TOP, left, width, height };
}

function clampRect(rect: FloatingRect): FloatingRect {
  if (typeof window === "undefined") return rect;
  const maxAvailableWidth = Math.max(MIN_DRAWER_WIDTH, window.innerWidth - SCREEN_PADDING * 2);
  const maxAvailableHeight = Math.max(MIN_DRAWER_HEIGHT, window.innerHeight - SCREEN_PADDING * 2);
  const width = Math.max(MIN_DRAWER_WIDTH, Math.min(maxAvailableWidth, rect.width));
  const height = Math.max(MIN_DRAWER_HEIGHT, Math.min(maxAvailableHeight, rect.height));
  const left = Math.max(SCREEN_PADDING, Math.min(window.innerWidth - width - SCREEN_PADDING, rect.left));
  const top = Math.max(SCREEN_PADDING, Math.min(window.innerHeight - height - SCREEN_PADDING, rect.top));
  return { top, left, width, height };
}

function loadPersistedRect(): FloatingRect | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(RECT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FloatingRect>;
    if (
      typeof parsed.top !== "number" ||
      typeof parsed.left !== "number" ||
      typeof parsed.width !== "number" ||
      typeof parsed.height !== "number"
    ) {
      return null;
    }
    return { top: parsed.top, left: parsed.left, width: parsed.width, height: parsed.height };
  } catch {
    return null;
  }
}

function savePersistedRect(rect: FloatingRect): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RECT_STORAGE_KEY, JSON.stringify(rect));
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
  // Persisted floating rectangle (top/left/width/height). Loaded once from
  // localStorage so the drawer reopens in the same spot the user left it.
  // Mobile mode ignores this — it always renders fixed inset-0.
  const [rect, setRect] = useState<FloatingRect>(() => clampRect(loadPersistedRect() ?? defaultRect()));
  const drawerRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Persist rect changes (debounced via React's batching). Skip mobile —
  // the rect state isn't used there and we don't want a fullscreen modal
  // session to overwrite a previously-saved desktop position.
  useEffect(() => {
    if (isMobile) return;
    savePersistedRect(rect);
  }, [isMobile, rect]);

  // Re-clamp when the viewport shrinks below the saved rect (e.g. window
  // resize, devtools open). Without this the drawer could be parked
  // off-screen with no way to drag it back.
  useEffect(() => {
    if (isMobile) return;
    const onResize = () => setRect((current) => clampRect(current));
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

  const previewQuery = useQuery({
    queryKey: ["me", "docs", "preview", docChatId, docAgentId, docBasePath, docPath],
    queryFn: () =>
      getMeDoc(docChatId ?? "", {
        agentId: docAgentId ?? "",
        basePath: docBasePath,
        path: docPath ?? "",
      }),
    // Skip the network round-trip when we already have an inline snapshot
    // pre-staged in the React Query cache — see chat-view click handler.
    enabled: hasDocRef && !inlineSnapshot,
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

  // Drag the floating drawer by its header. The header element opts into
  // dragging via this handler; interactive children (close button, etc.)
  // short-circuit on mousedown so they retain their own click semantics.
  const startDrag = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("button, a, input, textarea, select")) {
      return;
    }
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "grabbing";

    let startRect: FloatingRect | null = null;
    const onMouseMove = (moveEvent: MouseEvent) => {
      setRect((current) => {
        if (!startRect) startRect = current;
        return clampRect({
          ...current,
          top: startRect.top + (moveEvent.clientY - startY),
          left: startRect.left + (moveEvent.clientX - startX),
        });
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

  // Resize via the bottom-right corner grip. Tracks the initial rect at
  // drag-start so cumulative drag deltas stay stable across React state
  // updates (avoids the classic "rect drifts" bug from reading stale state).
  const startResize = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "nwse-resize";

    let startRect: FloatingRect | null = null;
    const onMouseMove = (moveEvent: MouseEvent) => {
      setRect((current) => {
        if (!startRect) startRect = current;
        return clampRect({
          ...current,
          width: startRect.width + (moveEvent.clientX - startX),
          height: startRect.height + (moveEvent.clientY - startY),
        });
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

  // Keyboard a11y for resize: ArrowLeft / Right adjust width, ArrowUp /
  // Down adjust height. The previous left-edge resize affordance went
  // away with the float, so the grip in the bottom-right corner takes
  // over its keyboard role.
  const resizeWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = RESIZE_KEY_STEP;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setRect((current) => clampRect({ ...current, width: current.width - step }));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setRect((current) => clampRect({ ...current, width: current.width + step }));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setRect((current) => clampRect({ ...current, height: current.height - step }));
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setRect((current) => clampRect({ ...current, height: current.height + step }));
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
        "z-40 flex flex-col bg-surface-raised text-text-primary shadow-2xl",
        "animate-in fade-in duration-150",
        isMobile
          ? "fixed inset-0 w-full border-l border-border"
          : "fixed overflow-hidden rounded-[var(--radius-dialog)] border border-border",
      )}
      onKeyDown={trapMobileFocus}
      ref={drawerRef}
      role="dialog"
      style={isMobile ? undefined : { top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
    >
      {/* Drag handle. The whole header opts into pointer-drag so the user
         can grab anywhere in the title strip, not just the grip glyph.
         Mouse-only by design: dragging a panel with the keyboard is an
         unusual pattern and would compete with the existing
         keyboard-resize handle in the bottom-right corner; keyboard
         users can rely on the persisted-rect default position instead. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: keyboard-equivalent provided by the bottom-right resize handle + persisted default position */}
      <header
        className={cn(
          "flex min-h-12 items-center gap-3 px-4 pt-3 pb-2",
          !isMobile && "cursor-grab select-none active:cursor-grabbing",
        )}
        onMouseDown={isMobile ? undefined : startDrag}
      >
        {isMobile ? null : <GripHorizontal aria-hidden="true" className="h-4 w-4 shrink-0 text-text-tertiary" />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-body font-medium">{title}</div>
          {subtitle ? <div className="truncate text-caption text-text-tertiary">{subtitle}</div> : null}
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

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {inlineSnapshot ? (
          <Markdown components={markdownComponents}>{inlineSnapshot.content}</Markdown>
        ) : (
          <>
            {previewQuery.isLoading ? (
              <div className="flex h-full items-center justify-center text-body text-text-secondary">
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

      {isMobile ? null : (
        <button
          aria-label="Resize document preview"
          className="absolute right-0 bottom-0 z-10 flex h-4 w-4 cursor-nwse-resize items-end justify-end p-0.5 text-text-tertiary hover:text-text-primary"
          onKeyDown={resizeWithKeyboard}
          onMouseDown={startResize}
          type="button"
        >
          <svg
            aria-hidden="true"
            className="h-2.5 w-2.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.25"
            viewBox="0 0 10 10"
          >
            <path d="M0 9 L9 0 M3.5 9 L9 3.5 M7 9 L9 7" />
          </svg>
        </button>
      )}
    </aside>
  );
}
