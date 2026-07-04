import type { DocStatus } from "@first-tree/shared";
import { buildDocAnchor } from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, MessageSquarePlus } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { createDocComment, findDocBySlug, getDoc, listDocComments, setDocStatus } from "../../api/docs.js";
import { Button } from "../../components/ui/button.js";
import { Markdown } from "../../components/ui/markdown.js";
import { PageHeader } from "../../components/ui/page-header.js";
import { Select } from "../../components/ui/select.js";
import { Textarea } from "../../components/ui/textarea.js";
import { DocCommentSidebar } from "./doc-comment-sidebar.js";
import { DOC_STATUS_LABELS, DocAuthorLabel, DocStatusChip } from "./doc-meta.js";

/** Rendered-context window captured around a selection for anchor scoring. */
const SELECTION_CONTEXT_CHARS = 64;

type PendingSelection = {
  text: string;
  renderedPrefix: string;
  renderedSuffix: string;
  /** Popover position relative to the content wrapper. */
  top: number;
  left: number;
};

/**
 * Document reading view: rendered markdown with text-selection commenting,
 * a threaded comment sidebar, version switching, and status controls. The
 * agent-facing mirror of this loop is `first-tree doc …`.
 */
export function DocPage() {
  const { slug } = useParams<{ slug: string }>();
  const queryClient = useQueryClient();
  const [viewVersion, setViewVersion] = useState<number | null>(null);

  const summaryQuery = useQuery({
    queryKey: ["doc-by-slug", slug],
    queryFn: () => findDocBySlug(slug ?? ""),
    enabled: !!slug,
  });
  const summary = summaryQuery.data ?? null;

  const docQuery = useQuery({
    queryKey: ["doc", summary?.id, viewVersion ?? "latest"],
    queryFn: () => getDoc(summary?.id ?? "", viewVersion ?? undefined),
    enabled: !!summary,
  });
  const doc = docQuery.data ?? null;

  const commentsQuery = useQuery({
    queryKey: ["doc-comments", summary?.id],
    queryFn: () => listDocComments(summary?.id ?? ""),
    enabled: !!summary,
  });
  const comments = commentsQuery.data?.items ?? [];

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["doc-by-slug", slug] });
    queryClient.invalidateQueries({ queryKey: ["doc", summary?.id] });
    queryClient.invalidateQueries({ queryKey: ["doc-comments", summary?.id] });
  }, [queryClient, slug, summary?.id]);

  const statusMutation = useMutation({
    mutationFn: (status: DocStatus) => setDocStatus(summary?.id ?? "", status),
    onSettled: invalidate,
  });

  // ── Text-selection commenting ─────────────────────────────────────────
  const contentWrapRef = useRef<HTMLDivElement | null>(null);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerBody, setComposerBody] = useState("");
  const [anchorFallback, setAnchorFallback] = useState(false);

  const captureSelection = useCallback(() => {
    if (composerOpen) return;
    const wrap = contentWrapRef.current;
    const selection = window.getSelection();
    if (!wrap || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      setPending(null);
      return;
    }
    const range = selection.getRangeAt(0);
    if (!wrap.contains(range.startContainer) || !wrap.contains(range.endContainer)) {
      setPending(null);
      return;
    }
    const text = selection.toString();
    if (text.trim().length === 0) {
      setPending(null);
      return;
    }
    // Rendered context on both sides of the selection, for anchor scoring
    // when the quoted text appears more than once in the source.
    const before = range.cloneRange();
    before.setStart(wrap, 0);
    const renderedPrefix = before.toString().slice(0, -text.length).slice(-SELECTION_CONTEXT_CHARS);
    const after = range.cloneRange();
    after.setEnd(wrap, wrap.childNodes.length);
    const renderedSuffix = after.toString().slice(text.length).slice(0, SELECTION_CONTEXT_CHARS);

    const rect = range.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    setPending({
      text,
      renderedPrefix,
      renderedSuffix,
      top: rect.bottom - wrapRect.top + 6,
      left: Math.max(0, rect.left - wrapRect.left),
    });
  }, [composerOpen]);

  const commentMutation = useMutation({
    mutationFn: async () => {
      if (!doc || !pending) throw new Error("Nothing selected");
      const anchor = buildDocAnchor({
        source: doc.version.content,
        selectedText: pending.text,
        renderedPrefix: pending.renderedPrefix,
        renderedSuffix: pending.renderedSuffix,
      });
      const body = composerBody.trim();
      if (anchor) {
        return createDocComment(doc.id, { body, anchor, versionNumber: doc.version.number });
      }
      // The selection spans markdown syntax and cannot be located in the
      // source — degrade VISIBLY to a document-level comment quoting it.
      const quoted = pending.text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      return createDocComment(doc.id, { body: `${quoted}\n\n${body}`, versionNumber: doc.version.number });
    },
    onSuccess: () => {
      setComposerOpen(false);
      setComposerBody("");
      setPending(null);
      setAnchorFallback(false);
      window.getSelection()?.removeAllRanges();
      invalidate();
    },
  });

  const versionOptions = useMemo(() => {
    const latest = summary?.latestVersion ?? 1;
    return Array.from({ length: latest }, (_, i) => {
      const n = latest - i;
      return { value: String(n), label: n === latest ? `v${n} (latest)` : `v${n}` };
    });
  }, [summary?.latestVersion]);

  if (summaryQuery.isLoading) {
    return <PageHeader title="Documents" subtitle="Loading…" />;
  }
  if (!summary) {
    return (
      <>
        <PageHeader title="Documents" />
        <div style={{ padding: "0 var(--sp-5)" }}>
          <p className="text-label" style={{ color: "var(--fg-3)" }}>
            No document with slug "{slug}".{" "}
            <Link to="/context/docs" style={{ color: "var(--primary)" }}>
              Back to the library
            </Link>
          </p>
        </div>
      </>
    );
  }

  const shownVersion = doc?.version.number ?? summary.latestVersion;
  const readOnlyOldVersion = shownVersion !== summary.latestVersion;

  return (
    <>
      <PageHeader
        title={summary.title}
        subtitle={
          <span className="inline-flex items-center gap-2">
            <Link
              to="/context/docs"
              aria-label="Back to documents"
              className="inline-flex items-center gap-1"
              style={{ color: "var(--fg-3)" }}
            >
              <ArrowLeft size={13} />
              Documents
            </Link>
            <span>·</span>
            {summary.slug}
            {summary.project ? <span>· {summary.project}</span> : null}
            <DocAuthorLabel author={summary.createdBy} />
          </span>
        }
        right={
          <div className="flex items-center gap-2">
            <DocStatusChip status={summary.status} />
            <Select
              value={String(shownVersion)}
              onChange={(value) => setViewVersion(Number.parseInt(value, 10))}
              options={versionOptions}
              aria-label="Version"
              triggerClassName="w-28"
            />
            <Select
              value={summary.status}
              onChange={(value) => statusMutation.mutate(value as DocStatus)}
              options={Object.entries(DOC_STATUS_LABELS).map(([value, label]) => ({ value, label }))}
              aria-label="Set status"
              triggerClassName="w-32"
            />
            {summary.status === "in_review" ? (
              <Button size="sm" onClick={() => statusMutation.mutate("approved")} disabled={statusMutation.isPending}>
                Approve
              </Button>
            ) : null}
          </div>
        }
      />

      <div
        className="flex"
        style={{ gap: "var(--sp-4)", padding: "0 var(--sp-5) var(--sp-5)", alignItems: "flex-start" }}
      >
        {/* biome-ignore lint/a11y/noStaticElementInteractions: passive selection capture, not click semantics — the handlers only read window.getSelection() after mouse (mouseup) or keyboard (shift+arrows → keyup) selections; there is nothing to activate. */}
        <div
          style={{ flex: 1, minWidth: 0, position: "relative" }}
          ref={contentWrapRef}
          onMouseUp={captureSelection}
          onKeyUp={captureSelection}
        >
          {readOnlyOldVersion ? (
            <p
              className="text-caption"
              style={{
                color: "var(--fg-3)",
                background: "var(--bg-active)",
                borderRadius: "var(--radius-input)",
                padding: "var(--sp-1) var(--sp-2)",
              }}
            >
              Viewing v{shownVersion} — comments go to the version you are viewing.
              {doc?.version.note ? ` Note: ${doc.version.note}` : ""}
            </p>
          ) : doc?.version.note ? (
            <p className="text-caption" style={{ color: "var(--fg-3)" }}>
              v{shownVersion} note: {doc.version.note}
            </p>
          ) : null}

          {docQuery.isLoading ? (
            <p className="text-label" style={{ color: "var(--fg-3)" }}>
              Loading content…
            </p>
          ) : null}
          {doc ? <Markdown>{doc.version.content}</Markdown> : null}

          {pending && !composerOpen ? (
            <div style={{ position: "absolute", top: pending.top, left: pending.left, zIndex: 20 }}>
              <Button
                size="sm"
                onClick={() => {
                  setAnchorFallback(
                    doc
                      ? buildDocAnchor({
                          source: doc.version.content,
                          selectedText: pending.text,
                          renderedPrefix: pending.renderedPrefix,
                          renderedSuffix: pending.renderedSuffix,
                        }) === null
                      : false,
                  );
                  setComposerOpen(true);
                }}
              >
                <MessageSquarePlus size={14} style={{ marginRight: 4 }} />
                Comment
              </Button>
            </div>
          ) : null}

          {pending && composerOpen ? (
            <div
              style={{
                position: "absolute",
                top: pending.top,
                left: Math.min(pending.left, 320),
                zIndex: 20,
                width: 360,
                background: "var(--bg-raised)",
                border: "var(--hairline) solid var(--border)",
                borderRadius: "var(--radius-input)",
                boxShadow: "var(--shadow-overlay, 0 8px 24px rgba(0,0,0,0.16))",
                padding: "var(--sp-3)",
              }}
            >
              <p className="m-0 text-caption truncate" style={{ color: "var(--fg-3)", marginBottom: "var(--sp-2)" }}>
                “{pending.text.length > 120 ? `${pending.text.slice(0, 120)}…` : pending.text}”
              </p>
              {anchorFallback ? (
                <p className="m-0 text-caption" style={{ color: "var(--warning-fg, #a16207)" }}>
                  This selection spans formatting, so it will post as a document-level comment quoting the text.
                </p>
              ) : null}
              <Textarea
                value={composerBody}
                onChange={(event) => setComposerBody(event.target.value)}
                placeholder="Leave a review comment…"
                rows={3}
                autoFocus
              />
              <div className="flex justify-end gap-2" style={{ marginTop: "var(--sp-2)" }}>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setComposerOpen(false);
                    setComposerBody("");
                    setPending(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => commentMutation.mutate()}
                  disabled={composerBody.trim().length === 0 || commentMutation.isPending}
                >
                  Comment
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        <DocCommentSidebar
          comments={comments}
          currentVersion={shownVersion}
          contentRef={contentWrapRef}
          onChanged={invalidate}
        />
      </div>
    </>
  );
}
