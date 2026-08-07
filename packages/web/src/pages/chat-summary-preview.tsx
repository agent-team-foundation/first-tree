import { useRef } from "react";
import { ChatSummary } from "./workspace/center/chat-summary.js";

/**
 * DEV-only visual review for the pinned ChatSummary (chat.description). No
 * backend / no auth — same gating as the other `/preview/*` routes (DEV-only in
 * `app.tsx`). Each demo wraps the summary in a faux white "chat header" + grey
 * "message stream" so the surface reads as it does live: the summary shares the
 * content canvas (`--bg`), set off from the white header (`--bg-raised`) above
 * by a single hairline + the natural bg step. Covers: the auto-expanded unread
 * summary-version state (amber highlight), collapsed-with-freshness, the
 * no-freshness-data fallback, the empty (renders nothing) case, and first-line
 * heading degradation. Click to expand / collapse. Scroll sticky-collapse + the
 * pinned shadow need the real stream and are verified in the live app.
 */

const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();

const CURRENT_STATE = [
  "Chat Summary now leads with the **current result and user impact**.",
  "Supporting context stays quieter and follows the card's own width, which matches the header and the collapsed bar above it.",
  "**Next:** Validate the same hierarchy in the live Workspace.",
].join("\n");

// The most common real shape: one physical line, no supporting copy. The lead is
// the whole summary here, so it must read as ordinary prose and must not reserve
// separation below itself.
const SINGLE_LINE =
  "正在核验团队的成员规模、First Tree 安装完成情况与实际使用情况。口径按 Asia/Taipei T+1 截止，并将安装状态与使用行为分开统计。";

const PLAIN = "Reviewing PR 1207 — server-side freshness fields landed; wiring the collapsed-bar first line next.";

const HEADING_FIRST = [
  "# 任务标题（章节标题，折叠行应跳过它）",
  "",
  "首个正文段落会被折叠行采用，这一句刻意写得很长，用来验证去掉 markdown 标记后仍以单行省略号截断、不撑高 chrome。",
].join("\n");

// Stands in for a real Workspace centre column. The summary surfaces stretch to
// this width, so the gallery shows the header, the collapsed bar, and the
// expanded card sharing one edge.
const PANEL: React.CSSProperties = {
  width: "calc(var(--sp-95) * 3)",
  maxWidth: "100%",
  background: "var(--bg)",
  border: "var(--hairline) solid var(--border)",
  borderRadius: "var(--radius-panel)",
  overflow: "hidden",
};

function Demo({
  chatId,
  description,
  descriptionUpdatedAt,
  lastReadAt,
}: {
  chatId: string;
  description: string | null;
  descriptionUpdatedAt: string | null;
  lastReadAt: string | null;
}) {
  // A dummy scroll container — the preview does not exercise sticky-collapse.
  const scrollRef = useRef<HTMLDivElement>(null);
  // The expanded summary is portaled into this `relative` wrapper and floated
  // over the message area, mirroring the live layout.
  const overlayRef = useRef<HTMLDivElement>(null);
  return (
    <div style={PANEL}>
      {/* Faux chat header (white chrome) so the summary's content-canvas tone
          reads against it exactly as it does live. */}
      <div
        className="text-caption"
        style={{ background: "var(--bg-raised)", padding: "var(--sp-3) var(--sp-6)", color: "var(--fg-3)" }}
      >
        (chat header)
      </div>
      <ChatSummary
        chatId={chatId}
        description={description}
        descriptionUpdatedAt={descriptionUpdatedAt}
        lastReadAt={lastReadAt}
        freshnessReady
        scrollContainerRef={scrollRef}
        overlayContainerRef={overlayRef}
      />
      {/* Faux message stream + the overlay positioning context. Min-height gives
          the floating card room to render in the gallery (clipped by the panel,
          as it is by the message area live). */}
      <div ref={overlayRef} style={{ position: "relative" }}>
        <div
          ref={scrollRef}
          className="text-caption"
          style={{ padding: "var(--sp-3) var(--sp-6)", color: "var(--fg-4)", minHeight: 280 }}
        >
          (message stream)
        </div>
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

export function ChatSummaryPreviewPage() {
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
          Chat summary — states
        </h1>
        <p className="text-body" style={{ color: "var(--fg-3)" }}>
          Each demo sits under a faux white header and over the grey content canvas, as it does live. Click to expand /
          collapse. Read-only: no edit affordance; expanded floats a card over the message area (it never pushes the
          stream down); the freshness ("9 days ago") lives on the bar in both states.
        </p>
      </div>

      <section style={{ display: "flex", flexDirection: "column", gap: "var(--sp-6)" }}>
        <Col label="Unread new summary version" note="auto-expands once + amber highlight · freshness on the bar">
          <Demo
            chatId="preview-unread"
            description={CURRENT_STATE}
            descriptionUpdatedAt={hoursAgo(2)}
            lastReadAt={null}
          />
        </Col>

        <Col
          label="Single-line brief (the common shape)"
          note="lead is the whole summary — ordinary weight, no reserved gap below it"
        >
          <Demo
            chatId="preview-single-line"
            description={SINGLE_LINE}
            descriptionUpdatedAt={hoursAgo(2)}
            lastReadAt={null}
          />
        </Col>

        <Col label="Recently updated, already seen" note="collapsed · freshness on the bar · vertical chevron">
          <Demo chatId="preview-seen" description={PLAIN} descriptionUpdatedAt={hoursAgo(3)} lastReadAt={hoursAgo(1)} />
        </Col>

        <Col label="Stale update, already seen" note="collapsed · older freshness">
          <Demo
            chatId="preview-stale"
            description={PLAIN}
            descriptionUpdatedAt={hoursAgo(240)}
            lastReadAt={hoursAgo(120)}
          />
        </Col>

        <Col label="No freshness data (existing chat)" note="collapsed · no freshness line (honest: not stamped yet)">
          <Demo chatId="preview-nofresh" description={PLAIN} descriptionUpdatedAt={null} lastReadAt={null} />
        </Col>

        <Col
          label="First line is a section heading"
          note="collapsed bar skips the heading → first prose line (truncated if long)"
        >
          <Demo
            chatId="preview-edge"
            description={HEADING_FIRST}
            descriptionUpdatedAt={hoursAgo(5)}
            lastReadAt={hoursAgo(4)}
          />
        </Col>

        <Col label="No description" note="renders nothing — no summary strip appears between header and stream">
          <Demo chatId="preview-empty" description={null} descriptionUpdatedAt={null} lastReadAt={null} />
        </Col>

        <Col
          label="Dark theme · unread"
          note="same as the first, wrapped in .dark (how it renders in the live workspace)"
        >
          <div className="dark" style={{ borderRadius: "var(--radius-panel)" }}>
            <Demo
              chatId="preview-dark"
              description={CURRENT_STATE}
              descriptionUpdatedAt={hoursAgo(2)}
              lastReadAt={null}
            />
          </div>
        </Col>
      </section>
    </div>
  );
}
