import { useRef } from "react";
import { TaskHeader } from "./workspace/center/task-header.js";

/**
 * DEV-only visual review for the pinned chat TaskHeader (chat.description).
 * No backend / no auth — same gating as the other `/preview/*` routes (DEV-only
 * in `app.tsx`). Covers: the auto-expanded "unread + not seen in a while" state
 * (amber highlight + green pulse dot), the collapsed-with-freshness state, the
 * muted "stale" dot, the no-freshness-data fallback (existing chats), the empty
 * (no description → renders nothing) case, and first-line degradation. Click a
 * header to expand / collapse. Scroll sticky-collapse is NOT exercised here (it
 * needs the real message stream); that is verified in the live app.
 */

const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();

const RICH = [
  "## 任务",
  "把右侧 summary 从「侧栏一段文字」改为**置顶可折叠任务头**。",
  "",
  "## 进展",
  "- 后端：`description_updated_at` / `description_updated_by` 已落库",
  "- 前端：任务头组件接入 chat-view，右栏只留成员",
  "",
  "## 下一步",
  "- gate 全绿后开 PR，详见 [关联 PR](#)。",
].join("\n");

const PLAIN = "Reviewing PR 1207 — server-side freshness fields landed; wiring the collapsed-bar first line next.";

const HEADING_FIRST = [
  "# 这是一个很长的标题，用来验证折叠行去掉 markdown 标记后的单行截断与优雅降级表现",
  "",
  "正文段落。",
].join("\n");

const PANEL: React.CSSProperties = {
  width: 720,
  maxWidth: "100%",
  background: "var(--bg-raised)",
  border: "var(--hairline) solid var(--border)",
  borderRadius: "var(--radius-panel)",
  overflow: "hidden",
};

function Demo({
  chatId,
  description,
  descriptionUpdatedAt,
  descriptionUpdatedByName,
  lastReadAt,
}: {
  chatId: string;
  description: string | null;
  descriptionUpdatedAt: string | null;
  descriptionUpdatedByName: string | null;
  lastReadAt: string | null;
}) {
  // A dummy scroll container — the preview does not exercise sticky-collapse.
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div style={PANEL}>
      <TaskHeader
        chatId={chatId}
        description={description}
        descriptionUpdatedAt={descriptionUpdatedAt}
        descriptionUpdatedByName={descriptionUpdatedByName}
        lastReadAt={lastReadAt}
        freshnessReady
        scrollContainerRef={scrollRef}
      />
      <div
        ref={scrollRef}
        className="text-caption"
        style={{ padding: "var(--sp-3) var(--sp-6)", color: "var(--fg-4)" }}
      >
        (message stream)
      </div>
    </div>
  );
}

function Col({ label, note, children }: { label: string; note: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
      <div>
        <div className="text-caption font-semibold" style={{ color: "var(--fg)" }}>
          {label}
        </div>
        <div className="text-caption" style={{ color: "var(--fg-4)" }}>
          {note}
        </div>
      </div>
      {children}
    </div>
  );
}

export function TaskHeaderPreviewPage() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        padding: "var(--sp-6)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-8)",
      }}
    >
      <div>
        <h1 className="text-title" style={{ color: "var(--fg)" }}>
          Chat task header — states
        </h1>
        <p className="text-body" style={{ color: "var(--fg-3)" }}>
          Click a header to expand / collapse. Read-only: there is no edit affordance anywhere — the footer states it is
          maintained by an agent.
        </p>
      </div>

      <section style={{ display: "flex", flexDirection: "column", gap: "var(--sp-6)" }}>
        <Col
          label="Unread + not seen in a while"
          note="auto-expands once + amber highlight · green pulse dot · faithful markdown"
        >
          <Demo
            chatId="preview-unread"
            description={RICH}
            descriptionUpdatedAt={hoursAgo(2)}
            descriptionUpdatedByName="ux-expert"
            lastReadAt={null}
          />
        </Col>

        <Col label="Recently updated, already seen" note="collapsed · green pulse dot · freshness + updater on the bar">
          <Demo
            chatId="preview-seen"
            description={PLAIN}
            descriptionUpdatedAt={hoursAgo(3)}
            descriptionUpdatedByName="gandy-developer"
            lastReadAt={hoursAgo(1)}
          />
        </Col>

        <Col label="Stale update, already seen" note="collapsed · muted grey dot (no pulse) · older freshness">
          <Demo
            chatId="preview-stale"
            description={PLAIN}
            descriptionUpdatedAt={hoursAgo(240)}
            descriptionUpdatedByName="gandy-s-assistant"
            lastReadAt={hoursAgo(120)}
          />
        </Col>

        <Col
          label="No freshness data (existing chat)"
          note="collapsed · grey dot · no freshness line (honest: not stamped yet)"
        >
          <Demo
            chatId="preview-nofresh"
            description={PLAIN}
            descriptionUpdatedAt={null}
            descriptionUpdatedByName={null}
            lastReadAt={null}
          />
        </Col>

        <Col
          label="First line is a heading + very long"
          note="collapsed bar strips markdown markers and truncates to one line"
        >
          <Demo
            chatId="preview-edge"
            description={HEADING_FIRST}
            descriptionUpdatedAt={hoursAgo(5)}
            descriptionUpdatedByName="ux-expert"
            lastReadAt={hoursAgo(4)}
          />
        </Col>

        <Col label="No description" note="renders nothing — the panel below has no header strip">
          <Demo
            chatId="preview-empty"
            description={null}
            descriptionUpdatedAt={null}
            descriptionUpdatedByName={null}
            lastReadAt={null}
          />
        </Col>

        <Col
          label="Dark theme · unread"
          note="same as the first, wrapped in .dark (how it renders in the live workspace)"
        >
          <div className="dark" style={{ borderRadius: "var(--radius-panel)" }}>
            <Demo
              chatId="preview-dark"
              description={RICH}
              descriptionUpdatedAt={hoursAgo(2)}
              descriptionUpdatedByName="ux-expert"
              lastReadAt={null}
            />
          </div>
        </Col>
      </section>
    </div>
  );
}
