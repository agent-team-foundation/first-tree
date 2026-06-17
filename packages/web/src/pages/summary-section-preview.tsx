import { Markdown } from "../components/ui/markdown.js";
import { DescriptionSection } from "./workspace/right-sidebar/description-section.js";

/**
 * DEV-only visual review for the right-rail "Summary" section (chat.description).
 * No backend / no auth — same gating as the other `/preview/*` routes (DEV-only
 * in `app.tsx`). Covers: Before vs After (the real DescriptionSection), dark
 * theme (the workspace adds `.dark`; these preview routes render light by
 * default), the capped + "Show more/less" state (GitHub section present below),
 * and markdown edge cases (table / long bare URL / deep nesting / quote / rule).
 * Rendered at real rail width with stress-test bodies.
 */

const SAMPLE = [
  "# 当前任务：修 Summary 标题格式",
  "",
  "正在收敛右栏 **Summary** 模块的标题层级方案，目标是窄栏下层次清晰、不喧宾夺主。",
  "",
  "## 背景",
  "`chat.description`（≤1500 字符）由 owning agent 维护，渲染为 markdown，承载 *背景 + 计划 + 进度*。",
  "",
  "## 进度",
  "- 已定位根因：`prose prose-sm` 未压标题字号、且把正文撑大",
  "- 标题收敛为「小节标签」，靠字重 + 留白做层级",
  "  - h1 / h2 用 subtitle 档",
  "  - h3+ 与正文齐平",
  "",
  "### 风险",
  "窄栏下表格 / 代码块可能溢出：",
  "",
  "```ts",
  "const cap = 30 // rem",
  "```",
  "",
  "#### 备注",
  "详见 [PR](#)。",
].join("\n");

// Long enough to exceed the ~30rem collapse cap, so capped mode shows the
// bottom fade + "Show more/less" toggle.
const LONG = [
  "# 周计划：Summary 模块体验整治",
  "",
  "本周聚焦右栏 Summary 的可读性，分三步推进，逐项落地并回归。",
  "",
  "## 背景",
  "Summary 是返回的人 / 刚加入的 agent 重建上下文的第一落点，但此前标题过大、正文偏大、空态无引导。",
  "",
  "## 计划",
  "1. 标题与正文字号收敛（本 PR）",
  "2. 空态占位 + 引导",
  "3. 「更新时间 / 作者」元信息",
  "4. human owner 内联编辑",
  "",
  "## 进度",
  "- 标题层级方案定稿并实现",
  "- 正文回归 12 档，与 rail 一致",
  "- 预览页覆盖 before/after、暗色、capped、边角",
  "",
  "### 风险",
  "- 仅 GitHub section 存在时才 cap，规则不够直觉",
  "- 30rem 为启发式数值，非布局自适应",
  "",
  "### 待确认",
  "- 是否一并修「正文偷偷 14 档」属于本 PR 范围",
  "- 元信息需要后端补字段",
  "",
  "#### 备注",
  "详见关联 PR 与 issue。",
].join("\n");

const EDGE = [
  "## 表格",
  "| 项 | 状态 |",
  "| --- | --- |",
  "| 标题字号 | 已修 |",
  "| 正文字号 | 已修 |",
  "",
  "## 长裸链接",
  "https://example.com/a/very/long/path?token=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ",
  "",
  "## 多级嵌套",
  "- 一级",
  "  - 二级",
  "    - 三级（窄栏缩进）",
  "- 又一级",
  "",
  "> 引用：层级靠字重 + 留白，而非字号。",
  "",
  "---",
  "",
  "末尾段落，验证 `last-child` 不留多余下边距。",
].join("\n");

const RAIL: React.CSSProperties = {
  width: 360,
  background: "var(--bg-raised)",
  border: "var(--hairline) solid var(--border)",
  borderRadius: "var(--radius-panel)",
  overflow: "hidden",
};

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

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
      <h2 className="text-subtitle" style={{ color: "var(--fg)" }}>
        {title}
      </h2>
      <div style={{ display: "flex", gap: "var(--sp-8)", alignItems: "flex-start", flexWrap: "wrap" }}>{children}</div>
    </section>
  );
}

/** Reproduces the section chrome WITHOUT the scoped type scale — i.e. today's
 *  behaviour: the shared Markdown's default `prose prose-sm`. */
function BeforeSection() {
  return (
    <section style={{ borderBottom: "var(--hairline) solid var(--border-faint)" }}>
      <div className="text-eyebrow" style={{ padding: "var(--sp-2_5) var(--sp-3) var(--sp-1)", color: "var(--fg-4)" }}>
        Summary
      </div>
      <div className="text-body" style={{ padding: "0 var(--sp-3) var(--sp-2_5)", color: "var(--fg)" }}>
        <Markdown>{SAMPLE}</Markdown>
      </div>
    </section>
  );
}

export function SummarySectionPreviewPage() {
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
          Right-rail Summary — heading & hierarchy
        </h1>
        <p className="text-body" style={{ color: "var(--fg-3)" }}>
          All rails at real width. After = the real DescriptionSection. Resize the window to test the narrow column.
        </p>
      </div>

      <Group title="1 · Light — Before vs After">
        <Col label="Before" note="prose-sm default · oversized headings · enlarged body">
          <div style={RAIL}>
            <BeforeSection />
          </div>
        </Col>
        <Col label="After" note="body --text-body · h1/h2 --text-subtitle · weight-led">
          <div style={RAIL}>
            <DescriptionSection description={SAMPLE} capped={false} />
          </div>
        </Col>
      </Group>

      <Group title="2 · Dark (workspace theme)">
        <Col label="After · dark" note="wrapped in .dark — how it renders in the live rail">
          <div className="dark" style={{ ...RAIL, background: "var(--bg-raised)" }}>
            <DescriptionSection description={SAMPLE} capped={false} />
          </div>
        </Col>
      </Group>

      <Group title="3 · Capped + Show more (GitHub section present below)">
        <Col label="After · capped" note="long body clamps to ~30rem with bottom fade + Show more/less">
          <div style={RAIL}>
            <DescriptionSection description={LONG} capped={true} />
          </div>
        </Col>
        <Col label="After · dark · capped" note="same, dark theme">
          <div className="dark" style={{ ...RAIL, background: "var(--bg-raised)" }}>
            <DescriptionSection description={LONG} capped={true} />
          </div>
        </Col>
      </Group>

      <Group title="4 · Markdown edge cases">
        <Col label="After · edge" note="table / long bare URL / 3-level nesting / quote / rule">
          <div style={RAIL}>
            <DescriptionSection description={EDGE} capped={false} />
          </div>
        </Col>
        <Col label="After · dark · edge" note="same, dark theme">
          <div className="dark" style={{ ...RAIL, background: "var(--bg-raised)" }}>
            <DescriptionSection description={EDGE} capped={false} />
          </div>
        </Col>
      </Group>
    </div>
  );
}
