import { useEffect } from "react";
import { ChatDescriptionInfo } from "../components/chat/chat-description-info.js";

/**
 * DEV-only visual review for the chat header's ⓘ description affordance
 * (`ChatDescriptionInfo`) and the surrounding title-cluster row.
 *
 * The real header (`chat-view.tsx`) needs a backend + auth + a chat that has a
 * `description` set, so this page reproduces just the header title-cluster
 * markup (topic button → optional entity slot → ⓘ) against fixtures and renders
 * the production `ChatDescriptionInfo` inside it. No backend / no auth — same
 * gating as the other `/preview/*` pages (DEV-only in `app.tsx`).
 *
 * Covers the spec acceptance: hover-preview / click-pin / Esc / outside-click
 * (interactive — try them), copyable body, a ~380-wide card with a 50vh inner scroll
 * on a long description, the icon hidden entirely when there is no description
 * (no dead entry point), and a long topic truncating while the ⓘ stays put.
 */

const SHORT = "Reviewing PR 987 — chat header description popover. Gates green, awaiting review.";

const LONG =
  "Chat header description 展示优化：方向已定为 icon-only（header 不直接展示文字）。" +
  "topic 之后只留一个 ⓘ 图标，hover ~300ms 预览、点击固定可复制、Esc / 点外关闭。" +
  "卡片约 380 宽（≈60ch），Description 小标签 + text-body 正文，超长 max-h 50vh 内滚动，底部一个复制按钮。" +
  "边界：纯前端单 PR，不动 description 的数据流与 CLI 写入路径；左侧 chat list 不在范围；" +
  "复用已有的 HoverCard primitive，样式全部走 DESIGN.md token，不新增魔法数。" +
  "这一段刻意写得很长，用来验证卡片在内容超过半屏时会在自己的卡片内滚动，而不是把卡片撑出视口。" +
  "再补一句，确认行宽稳定在约 60 个字符的舒适阅读度量，长文本仍然可选中、可复制。";

const LONG_TOPIC = "本周 ship 计划 — onboarding org-repos picker + resources typed editors + 一堆收尾";

type Row = { name: string; subtitle: string; topic: string; description: string | null; narrow?: boolean };

const ROWS: Row[] = [
  {
    name: "short description",
    subtitle: "hover the ⓘ to preview, click to pin + copy",
    topic: "Chat header description 展示优化",
    description: SHORT,
  },
  {
    name: "long description (50vh inner scroll)",
    subtitle: "card caps at ~380 wide / 50vh tall and scrolls its own body",
    topic: "Chat header description 展示优化",
    description: LONG,
  },
  {
    name: "no description → no ⓘ (no dead entry point)",
    subtitle: "the icon is absent entirely when description is unset",
    topic: "A freshly created chat with no description yet",
    description: null,
  },
  {
    name: "long topic truncates, ⓘ stays put",
    subtitle: "topic ellipsizes; the ⓘ never gets pushed off the row",
    topic: LONG_TOPIC,
    description: SHORT,
  },
  {
    name: "narrow viewport (mobile width)",
    subtitle: "row stays single-line; topic truncates, ⓘ pinned to the right",
    topic: LONG_TOPIC,
    description: SHORT,
    narrow: true,
  },
];

/** A faithful copy of the chat-view title-cluster row (topic button + ⓘ). */
function HeaderRowMimic({ topic, description }: { topic: string; description: string | null }) {
  return (
    <div className="flex min-w-0 items-center" style={{ flex: 1, gap: "var(--sp-1)" }}>
      <button
        type="button"
        title="Click to rename"
        className="min-w-0 truncate text-subtitle font-semibold text-left"
        style={{ color: "var(--fg)", background: "transparent", border: "none", padding: 0, cursor: "pointer" }}
      >
        {topic}
      </button>
      {description ? <ChatDescriptionInfo description={description} /> : null}
    </div>
  );
}

export function ChatDescriptionPreviewPage() {
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const themeOverride = params.get("theme");
  useEffect(() => {
    if (themeOverride === "light" || themeOverride === "dark") {
      document.documentElement.classList.toggle("dark", themeOverride === "dark");
    }
  }, [themeOverride]);

  return (
    <div style={{ background: "var(--bg)", minHeight: "100vh", padding: "var(--sp-6)" }}>
      <div style={{ maxWidth: 980, margin: "0 auto" }}>
        <h1 className="text-title" style={{ color: "var(--fg-2)", marginBottom: "var(--sp-1)" }}>
          Chat header — ⓘ description affordance
        </h1>
        <p className="text-body" style={{ color: "var(--fg-3)", marginBottom: "var(--sp-6)" }}>
          DEV preview. Each card reproduces the chat header's title-cluster row and renders the production{" "}
          <code>ChatDescriptionInfo</code>. Hover / click / Esc are live. Append <code>?theme=dark</code> to flip the
          theme.
        </p>
        <div className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
          {ROWS.map((r) => (
            <section key={r.name} className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
              <div>
                <div className="text-label" style={{ color: "var(--fg-2)" }}>
                  {r.name}
                </div>
                <div className="text-caption" style={{ color: "var(--fg-4)" }}>
                  {r.subtitle}
                </div>
              </div>
              {/* Header-strip mimic: raised surface + hairline like the real
                  chat header bar; constrained width for the narrow case. */}
              <div
                className="flex items-center"
                style={{
                  maxWidth: r.narrow ? 380 : undefined,
                  background: "var(--bg-raised)",
                  border: "var(--hairline) solid var(--border)",
                  borderRadius: "var(--radius-panel)",
                  padding: "var(--sp-2) var(--sp-3)",
                  gap: "var(--sp-2)",
                }}
              >
                <HeaderRowMimic topic={r.topic} description={r.description} />
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
