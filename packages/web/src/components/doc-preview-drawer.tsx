import { type AttachmentRef, attachmentRefsFromMetadata, normalizeDocLinkPath } from "@first-tree/shared";
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
import { downloadAttachment, fetchAttachmentText, sha256Hex } from "../api/attachments.js";
import { listChatMessages } from "../api/chats.js";
import { attachmentIdFromHref } from "../lib/doc-preview-links.js";
import { isNavigableWebHref } from "../lib/safe-href.js";
import { cn } from "../lib/utils.js";
import { docAttachmentRefQueryKey, docMessageAttachmentRefsQueryKey } from "../pages/workspace/center/chat-view.js";
import { Button } from "./ui/button.js";
import { Markdown } from "./ui/markdown.js";

const DEFAULT_MAX_WIDTH = 1200;
const DEFAULT_VIEWPORT_RATIO = 0.55;
const MIN_DRAWER_WIDTH = 360;
/**
 * Reserved layout width the drawer must NOT eat into when it expands. Covers the
 * fixed left conversation rail plus a minimum readable chat column.
 */
const RESERVED_MAIN_WIDTH = 640;
const RESIZE_KEY_STEP = 24;
const WIDTH_STORAGE_KEY = "first-tree:doc-preview-drawer:width:v1";

/**
 * Preview render size cap — separate from (and far below) the 10MB upload cap.
 * A multi-MB markdown string would choke react-markdown / the DOM, so above
 * this we show a "too large" download fallback instead of rendering.
 */
const MAX_PREVIEW_RENDER_BYTES = 1024 * 1024;

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

type PreviewState =
  | { kind: "text"; text: string; integrityWarning: boolean }
  | { kind: "too-large"; sizeBytes: number };

/**
 * Markdown preview rail to the right of the chat reading column.
 *
 * Data source: a doc is referenced by `metadata.attachments[]` as a generic
 * `AttachmentRef` (kind: "document"). The drawer reads the ref (seeded into the
 * React Query cache by the chat-view click handler, or recovered from the
 * message metadata on a cold deep-link / reload), then fetches the bytes from
 * `GET /attachments/:id`, verifies them against `ref.sha256` (best-effort
 * integrity warning on mismatch), enforces a render size cap, and renders the
 * markdown. Bytes are cached by attachmentId, so re-opens and in-doc cross
 * links to sibling docs in the same message are network-free after first load.
 *
 * Graceful degradation: an OLD message whose metadata still has the legacy
 * inline shape carries no `attachments` ref, so clicking such a (legacy bare)
 * link never reaches this drawer; if a stale URL points at an attachment that
 * no longer resolves, the fetch error path renders an inline error rather than
 * throwing.
 */
export function DocPreviewDrawer() {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const docChatId = searchParams.get("docChat");
  const docMsgId = searchParams.get("docMsg");
  const docAttachmentId = searchParams.get("docAttachment");
  const hasDocRef = Boolean(docAttachmentId);

  // The ref carries filename / sha256 / source.path. Prefer the seeded cache
  // (synchronous, network-free after a click); recover from the message
  // metadata on a cold reload by re-reading the chat's messages window.
  const seededRef = docAttachmentId
    ? queryClient.getQueryData<AttachmentRef>(docAttachmentRefQueryKey(docAttachmentId))
    : undefined;
  const recoveryEnabled = Boolean(docChatId && docMsgId && docAttachmentId && !seededRef);
  const recoveryMessages = useQuery({
    queryKey: ["chat-messages", docChatId],
    queryFn: () => listChatMessages(docChatId ?? "", { limit: 50 }),
    enabled: recoveryEnabled,
  });
  const recoveredRef = useMemo<AttachmentRef | undefined>(() => {
    if (seededRef || !docMsgId || !docAttachmentId) return undefined;
    const message = recoveryMessages.data?.items.find((item) => item.id === docMsgId);
    if (!message) return undefined;
    return attachmentRefsFromMetadata(message.metadata).find((r) => r.attachmentId === docAttachmentId);
  }, [seededRef, docMsgId, docAttachmentId, recoveryMessages.data]);
  const docRef = seededRef ?? recoveredRef;
  const awaitingRecovery = recoveryEnabled && !recoveredRef && recoveryMessages.isLoading;
  const recoveryMiss = recoveryEnabled && !recoveredRef && !recoveryMessages.isLoading && !recoveryMessages.isFetching;
  const previewWillBeUnverifiedAfterRecoveryMiss = recoveryMiss && !docRef;

  const isMobile = useIsMobileDocPreview();
  const [drawerWidth, setDrawerWidth] = useState<number>(() =>
    clampDrawerWidth(loadPersistedWidth() ?? defaultDrawerWidth()),
  );
  const drawerRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (isMobile) return;
    savePersistedWidth(drawerWidth);
  }, [isMobile, drawerWidth]);

  useEffect(() => {
    if (isMobile) return;
    const onResize = () => setDrawerWidth((current) => clampDrawerWidth(current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [isMobile]);

  const close = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete("docChat");
    next.delete("docMsg");
    next.delete("docAttachment");
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

  // Fetch + verify the doc bytes.
  //
  // The query key includes the expected sha256 so a late-arriving ref (cold
  // deep-link, where the ref is recovered AFTER first render) forces a
  // refetch+reverify rather than serving a previously-fetched-but-unverified
  // cached state. Combined with the `enabled` gate below — which holds the
  // fetch until recovery settles whenever a ref is recoverable — this enforces
  // the invariant: whenever a ref with a sha256 is available, the rendered
  // preview was verified against it. A truly ref-less orphan (no msgId to
  // recover from) still fetches unverified, which is acceptable. A stale deep
  // link with msgId outside the recovery window also fetches unverified after
  // recovery misses, but renders a visible warning instead of a blank drawer.
  const previewQuery = useQuery<PreviewState>({
    queryKey: ["doc-attachment-preview", docAttachmentId, docRef?.sha256 ?? null],
    queryFn: async (): Promise<PreviewState> => {
      const id = docAttachmentId ?? "";
      const fetched = await fetchAttachmentText(id);
      if (fetched.sizeBytes > MAX_PREVIEW_RENDER_BYTES) {
        return { kind: "too-large", sizeBytes: fetched.sizeBytes };
      }
      let integrityWarning = false;
      const expected = docRef?.sha256;
      if (expected) {
        try {
          const actual = await sha256Hex(fetched.text);
          integrityWarning = actual !== expected;
        } catch {
          // Web Crypto unavailable (e.g. insecure context) — skip verification.
          integrityWarning = false;
        }
      }
      return { kind: "text", text: fetched.text, integrityWarning };
    },
    // Hold the fetch only while recovery is still in flight (`awaitingRecovery`).
    // Once recovery SETTLES — whether it produced the ref or missed (e.g. the
    // message is older than the recovery window) — we fetch: with the ref it
    // verifies (sha256 in the key); on a miss it fetches unverified with a
    // visible warning instead of leaving the drawer stuck idle/blank.
    enabled: Boolean(docAttachmentId) && !awaitingRecovery,
  });

  // SECURITY: `docRef.source.path` is UNTRUSTED, DISPLAY-ONLY metadata supplied
  // by the sending runtime (see `AttachmentRef.source` in attachment-ref.ts). It
  // is rendered purely as the drawer title/subtitle here — it must NEVER be used
  // for authorization, routing, or filesystem access. The doc bytes are fetched
  // by the capability-based attachmentId, not by this path.
  const title = useMemo(() => {
    const path = docRef?.source?.path ?? docRef?.filename ?? "";
    return path.split("/").filter(Boolean).at(-1) ?? path;
  }, [docRef]);
  const docSourcePath = docRef?.source?.path ?? docRef?.filename ?? null;
  const subtitle = docSourcePath && docSourcePath !== title ? docSourcePath : null;

  // Map a click on an in-doc markdown link to a sibling doc ref in the SAME
  // message (matched by `source.path`) so cross-navigation stays inside the
  // attachment model. Falls back to no-op when the target isn't a sibling doc.
  const siblingRefsByPath = useMemo(() => {
    const map = new Map<string, AttachmentRef>();
    if (!docMsgId) return map;
    // Seeded siblings (common click path): the chat-view click handler stashes
    // the message's FULL ref list under a per-message key. Read it so relative
    // `other.md` links resolve without re-fetching the messages window.
    const seededMessageRefs =
      queryClient.getQueryData<AttachmentRef[]>(docMessageAttachmentRefsQueryKey(docMsgId)) ?? [];
    for (const r of seededMessageRefs) {
      if (r.kind === "document" && r.source?.path) map.set(r.source.path, r);
    }
    // Recovered siblings (cold load / deep link): the click cache is empty, so
    // enumerate from the recovered messages window instead.
    const message = recoveryMessages.data?.items.find((item) => item.id === docMsgId);
    const recoveredRefs = message ? attachmentRefsFromMetadata(message.metadata) : [];
    for (const r of recoveredRefs) {
      if (r.kind === "document" && r.source?.path) map.set(r.source.path, r);
    }
    // Always include the current ref so a self-link resolves.
    if (docRef?.source?.path) map.set(docRef.source.path, docRef);
    return map;
  }, [docMsgId, queryClient, recoveryMessages.data, docRef]);

  const openSiblingAttachment = useCallback(
    (attachmentId: string) => {
      const next = new URLSearchParams(searchParams);
      next.set("docAttachment", attachmentId);
      setSearchParams(next);
    },
    [searchParams, setSearchParams],
  );

  // Over-cap fallback: download the bytes through the authed api helper rather
  // than navigating to a page-relative `/api/v1/...` (no auth header → 401,
  // wrong origin → 404). The download filename prefers the captured filename.
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const handleDownload = useCallback(async () => {
    if (!docAttachmentId) return;
    setDownloadError(null);
    try {
      await downloadAttachment(docAttachmentId, docRef?.filename ?? "document.md");
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : "Download failed");
    }
  }, [docAttachmentId, docRef]);

  const markdownComponents = useMemo<Components>(
    () => ({
      a({ href, children, ...props }) {
        // An `attachment:<id>` link inside the doc → open that sibling doc.
        const inDocAttachmentId = typeof href === "string" ? attachmentIdFromHref(href) : null;
        // A relative `.md` link resolved against the current doc's source path,
        // matched to a sibling ref's source.path.
        const siblingId =
          typeof href === "string" ? resolveSiblingByPath(href, docSourcePath, siblingRefsByPath) : null;
        const targetId = inDocAttachmentId ?? siblingId;
        if (!targetId && !isNavigableWebHref(href)) {
          return <>{children}</>;
        }
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
          if (!targetId) return;
          event.preventDefault();
          openSiblingAttachment(targetId);
        };

        return (
          <a {...props} href={href} onClick={onClick} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      },
    }),
    [docSourcePath, siblingRefsByPath, openSiblingAttachment],
  );

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
          <div className="mx-auto h-full w-px bg-border-faint opacity-60 transition-all group-hover:w-1 group-hover:bg-accent group-hover:opacity-100" />
        </button>
      )}

      <header className="flex shrink-0 items-center gap-3 px-4" style={{ height: 52, background: "var(--bg-raised)" }}>
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
        {awaitingRecovery || previewQuery.isLoading ? (
          <div className="flex h-full items-center justify-center text-body text-fg-2">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            Loading preview
          </div>
        ) : previewQuery.isError ? (
          <div className="rounded-[var(--radius-panel)] border border-error bg-error-soft p-4 text-body text-error">
            {previewQuery.error instanceof Error ? previewQuery.error.message : "Unable to load document"}
          </div>
        ) : previewQuery.data?.kind === "too-large" ? (
          <div className="rounded-[var(--radius-panel)] border border-border bg-bg-sunken p-4 text-body text-fg-2">
            {previewWillBeUnverifiedAfterRecoveryMiss ? (
              <div className="mb-3 rounded-[var(--radius-panel)] border border-warn bg-warn-soft p-2 text-caption text-warn">
                Unable to recover document metadata from the recent message window. This preview was not checksum
                verified.
              </div>
            ) : null}
            This document is too large to preview ({Math.round(previewQuery.data.sizeBytes / 1024)} KB).{" "}
            {docAttachmentId ? (
              <button type="button" onClick={handleDownload} className="underline">
                Download to view
              </button>
            ) : null}
            {downloadError ? <div className="mt-2 text-caption text-error">{downloadError}</div> : null}
          </div>
        ) : previewQuery.data?.kind === "text" ? (
          <>
            {previewWillBeUnverifiedAfterRecoveryMiss ? (
              <div className="mb-3 rounded-[var(--radius-panel)] border border-warn bg-warn-soft p-2 text-caption text-warn">
                Unable to recover document metadata from the recent message window. This preview was not checksum
                verified.
              </div>
            ) : null}
            {previewQuery.data.integrityWarning ? (
              <div className="mb-3 rounded-[var(--radius-panel)] border border-warn bg-warn-soft p-2 text-caption text-warn">
                Integrity check failed — the fetched content does not match the captured checksum.
              </div>
            ) : null}
            <Markdown components={markdownComponents}>{previewQuery.data.text}</Markdown>
          </>
        ) : null}
      </div>
    </aside>
  );
}

/**
 * Resolve a relative in-doc markdown link (`../api.md`, `design.md`) against the
 * currently-open doc's `source.path`, then match it to a sibling ref's
 * `source.path`. Returns the sibling's attachmentId or null.
 */
function resolveSiblingByPath(
  href: string,
  currentDocPath: string | null,
  siblingRefsByPath: ReadonlyMap<string, AttachmentRef>,
): string | null {
  const pathPart = href.trim().split(/[?#]/, 1).at(0) ?? "";
  if (!pathPart.toLowerCase().endsWith(".md")) return null;
  let candidate = pathPart;
  if (currentDocPath && !pathPart.startsWith("/")) {
    const slash = currentDocPath.lastIndexOf("/");
    const base = slash >= 0 ? currentDocPath.slice(0, slash + 1) : "";
    candidate = `${base}${pathPart}`;
  }
  const normalized = normalizeDocLinkPath(candidate);
  if (!normalized) return null;
  return siblingRefsByPath.get(normalized)?.attachmentId ?? null;
}
