import type { DocComment } from "@first-tree/shared";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, RotateCcw } from "lucide-react";
import type { RefObject } from "react";
import { useMemo, useState } from "react";
import { replyDocComment, setDocCommentStatus } from "../../api/docs.js";
import { Button } from "../../components/ui/button.js";
import { Textarea } from "../../components/ui/textarea.js";
import { formatRelative } from "../../lib/utils.js";
import { DocAuthorLabel } from "./doc-meta.js";

type Thread = { root: DocComment; replies: DocComment[] };

/**
 * Threaded review comments. Threads group by the top-level comment; a
 * thread's status lives on its root (replies follow). Clicking a quote
 * scrolls the rendered content to the first text match — a lightweight
 * locator that keeps the markdown renderer untouched.
 */
export function DocCommentSidebar({
  comments,
  currentVersion,
  contentRef,
  onChanged,
}: {
  comments: DocComment[];
  currentVersion: number;
  contentRef: RefObject<HTMLDivElement | null>;
  onChanged: () => void;
}) {
  const { open, resolved } = useMemo(() => {
    const roots = comments.filter((c) => c.parentId === null);
    const byParent = new Map<string, DocComment[]>();
    for (const c of comments) {
      if (!c.parentId) continue;
      const list = byParent.get(c.parentId) ?? [];
      list.push(c);
      byParent.set(c.parentId, list);
    }
    const toThread = (root: DocComment): Thread => ({ root, replies: byParent.get(root.id) ?? [] });
    return {
      open: roots.filter((r) => r.status === "open").map(toThread),
      resolved: roots.filter((r) => r.status === "resolved").map(toThread),
    };
  }, [comments]);

  const [showResolved, setShowResolved] = useState(false);

  return (
    <aside style={{ width: 320, flexShrink: 0 }} aria-label="Review comments">
      <h2 className="m-0 text-label font-semibold" style={{ color: "var(--fg-2)", marginBottom: "var(--sp-2)" }}>
        Comments {open.length > 0 ? `(${open.length} open)` : ""}
      </h2>
      {open.length === 0 ? (
        <p className="text-caption" style={{ color: "var(--fg-3)" }}>
          No open comments. Select text in the document to start one.
        </p>
      ) : null}
      <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
        {open.map((thread) => (
          <ThreadCard
            key={thread.root.id}
            thread={thread}
            currentVersion={currentVersion}
            contentRef={contentRef}
            onChanged={onChanged}
          />
        ))}
      </div>

      {resolved.length > 0 ? (
        <div style={{ marginTop: "var(--sp-4)" }}>
          <button
            type="button"
            className="text-caption"
            style={{ color: "var(--fg-3)", background: "none", border: "none", cursor: "pointer", padding: 0 }}
            onClick={() => setShowResolved((prev) => !prev)}
          >
            {showResolved ? "Hide" : "Show"} {resolved.length} resolved
          </button>
          {showResolved ? (
            <div className="flex flex-col" style={{ gap: "var(--sp-3)", marginTop: "var(--sp-2)", opacity: 0.75 }}>
              {resolved.map((thread) => (
                <ThreadCard
                  key={thread.root.id}
                  thread={thread}
                  currentVersion={currentVersion}
                  contentRef={contentRef}
                  onChanged={onChanged}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

function ThreadCard({
  thread,
  currentVersion,
  contentRef,
  onChanged,
}: {
  thread: Thread;
  currentVersion: number;
  contentRef: RefObject<HTMLDivElement | null>;
  onChanged: () => void;
}) {
  const { root, replies } = thread;
  const [replyBody, setReplyBody] = useState("");
  const [replyOpen, setReplyOpen] = useState(false);

  const replyMutation = useMutation({
    mutationFn: () => replyDocComment(root.id, replyBody.trim()),
    onSuccess: () => {
      setReplyBody("");
      setReplyOpen(false);
      onChanged();
    },
  });
  const statusMutation = useMutation({
    mutationFn: (status: "open" | "resolved") => setDocCommentStatus(root.id, status),
    onSettled: onChanged,
  });

  return (
    <div
      style={{
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-input)",
        padding: "var(--sp-3)",
        background: "var(--bg-raised)",
      }}
    >
      {root.anchor ? (
        <button
          type="button"
          onClick={() => scrollToQuote(contentRef.current, root.anchor?.exact ?? "")}
          className="block w-full text-left text-caption truncate"
          style={{
            color: "var(--fg-3)",
            borderLeft: "2px solid var(--primary)",
            paddingLeft: "var(--sp-2)",
            marginBottom: "var(--sp-2)",
            background: "none",
            border: "none",
            borderInlineStart: "2px solid var(--primary)",
            cursor: "pointer",
          }}
          title="Locate in document"
        >
          {root.anchor.exact}
        </button>
      ) : null}
      <div className="flex items-center gap-2" style={{ marginBottom: 2 }}>
        <DocAuthorLabel author={root.author} />
        <span className="text-caption" style={{ color: "var(--fg-3)" }}>
          {formatRelative(root.createdAt)}
        </span>
        {root.versionNumber !== currentVersion ? (
          <span className="text-caption" style={{ color: "var(--fg-3)" }}>
            on v{root.versionNumber}
          </span>
        ) : null}
        <div style={{ flex: 1 }} />
        {root.status === "open" ? (
          <button
            type="button"
            aria-label="Resolve thread"
            title="Resolve"
            onClick={() => statusMutation.mutate("resolved")}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--fg-3)", padding: 0 }}
          >
            <CheckCircle2 size={15} />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Reopen thread"
            title="Reopen"
            onClick={() => statusMutation.mutate("open")}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--fg-3)", padding: 0 }}
          >
            <RotateCcw size={15} />
          </button>
        )}
      </div>
      <p className="m-0 text-label" style={{ color: "var(--fg)", whiteSpace: "pre-wrap" }}>
        {root.body}
      </p>

      {replies.map((reply) => (
        <div key={reply.id} style={{ marginTop: "var(--sp-2)", paddingLeft: "var(--sp-3)" }}>
          <div className="flex items-center gap-2">
            <DocAuthorLabel author={reply.author} />
            <span className="text-caption" style={{ color: "var(--fg-3)" }}>
              {formatRelative(reply.createdAt)}
            </span>
          </div>
          <p className="m-0 text-label" style={{ color: "var(--fg)", whiteSpace: "pre-wrap" }}>
            {reply.body}
          </p>
        </div>
      ))}

      {replyOpen ? (
        <div style={{ marginTop: "var(--sp-2)" }}>
          <Textarea
            value={replyBody}
            onChange={(event) => setReplyBody(event.target.value)}
            placeholder="Reply…"
            rows={2}
            autoFocus
          />
          <div className="flex justify-end gap-2" style={{ marginTop: "var(--sp-1)" }}>
            <Button size="sm" variant="ghost" onClick={() => setReplyOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => replyMutation.mutate()}
              disabled={replyBody.trim().length === 0 || replyMutation.isPending}
            >
              Reply
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="text-caption"
          style={{
            color: "var(--fg-3)",
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 0,
            marginTop: "var(--sp-2)",
          }}
          onClick={() => setReplyOpen(true)}
        >
          Reply
        </button>
      )}
    </div>
  );
}

/**
 * Scroll the rendered content to the first element containing the quoted
 * text (whitespace-insensitive) and flash it. Best-effort locator — an
 * unlocatable quote (edited away in this version) simply doesn't scroll.
 */
function scrollToQuote(container: HTMLDivElement | null, quote: string): void {
  if (!container || quote.trim().length === 0) return;
  const needle = quote.replace(/\s+/g, " ").trim().toLowerCase();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const parent = node.parentElement;
    if (parent && (parent.textContent ?? "").replace(/\s+/g, " ").toLowerCase().includes(needle)) {
      parent.scrollIntoView({ behavior: "smooth", block: "center" });
      const previous = parent.style.backgroundColor;
      parent.style.backgroundColor = "var(--bg-active)";
      parent.style.transition = "background-color 1.2s ease";
      window.setTimeout(() => {
        parent.style.backgroundColor = previous;
      }, 1200);
      return;
    }
    node = walker.nextNode();
  }
}
