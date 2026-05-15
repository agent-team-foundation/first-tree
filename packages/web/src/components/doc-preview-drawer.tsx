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
import { cn } from "../lib/utils.js";
import { type DocSnapshotEntry, docSnapshotQueryKey } from "../pages/workspace/center/chat-view.js";
import { Button } from "./ui/button.js";
import { Markdown } from "./ui/markdown.js";

const DEFAULT_MAX_WIDTH = 720;
const DEFAULT_VIEWPORT_RATIO = 0.45;
const MIN_DRAWER_WIDTH = 360;
const RESERVED_MAIN_WIDTH = 320;
const RESIZE_KEY_STEP = 24;

function defaultDrawerWidth(): number {
  if (typeof window === "undefined") return DEFAULT_MAX_WIDTH;
  return Math.max(
    MIN_DRAWER_WIDTH,
    Math.min(DEFAULT_MAX_WIDTH, Math.round(window.innerWidth * DEFAULT_VIEWPORT_RATIO)),
  );
}

function clampDrawerWidth(width: number): number {
  const maxWidth = Math.max(MIN_DRAWER_WIDTH, window.innerWidth - RESERVED_MAIN_WIDTH);
  return Math.min(Math.max(width, MIN_DRAWER_WIDTH), maxWidth);
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
  const [drawerWidth, setDrawerWidth] = useState(defaultDrawerWidth);
  const drawerRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

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

  const startResize = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (moveEvent: MouseEvent) => {
      setDrawerWidth(clampDrawerWidth(window.innerWidth - moveEvent.clientX));
    };
    const onMouseUp = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, []);

  const resizeWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setDrawerWidth((current) => clampDrawerWidth(current + RESIZE_KEY_STEP));
    }
    if (event.key === "ArrowRight") {
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
        "z-40 flex flex-col bg-surface-raised text-text-primary shadow-2xl",
        "animate-in slide-in-from-right duration-200",
        isMobile
          ? "fixed inset-0 w-full border-l border-border"
          : "relative my-3 mr-3 h-auto shrink-0 overflow-hidden rounded-[var(--radius-panel)] border border-border-faint max-w-[calc(100vw-var(--sp-8))]",
      )}
      onKeyDown={trapMobileFocus}
      ref={drawerRef}
      role="dialog"
      style={isMobile ? undefined : { width: drawerWidth }}
    >
      {isMobile ? null : (
        <button
          aria-label="Resize document preview"
          className="group absolute top-0 left-0 h-full w-3 -translate-x-1/2 cursor-col-resize"
          onMouseDown={startResize}
          onKeyDown={resizeWithKeyboard}
          type="button"
        >
          <div className="mx-auto h-full w-1 bg-accent opacity-0 transition-opacity group-hover:opacity-100" />
        </button>
      )}

      <header className="flex min-h-12 items-center gap-3 px-4 pt-3 pb-2">
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
    </aside>
  );
}
