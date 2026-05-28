import { type ReactNode, useEffect, useState } from "react";
import { AgentStatusChip } from "../components/ui/agent-status-chip.js";
import { Badge } from "../components/ui/badge.js";
import { Breadcrumb, BreadcrumbCurrent, BreadcrumbLink, BreadcrumbSep } from "../components/ui/breadcrumb.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { DenseBadge } from "../components/ui/dense-badge.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog.js";
import { FilterPill } from "../components/ui/filter-pill.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Panel, PanelBody, PanelHeader, PanelTitle } from "../components/ui/panel.js";
import { Popover } from "../components/ui/popover.js";
import { PresenceChip } from "../components/ui/presence-chip.js";
import { SectionHeader, UppercaseLabel } from "../components/ui/section-header.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { StateChip } from "../components/ui/state-chip.js";
import { StateDot } from "../components/ui/state-dot.js";
import { StatusGlyph } from "../components/ui/status-glyph.js";
import { Tab, TabBadge, TabBar } from "../components/ui/tab-bar.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { Tile } from "../components/ui/tile.js";
import { useToast } from "../components/ui/toast.js";

/**
 * Human-facing visual reference for the web design system. Renders the real
 * tokens (color / typography / spacing / radius / surfaces) and the real
 * `components/ui` primitives in every variant, so a person can SEE the system
 * instead of reading hex values out of `index.css`.
 *
 * Companion to `DESIGN.md` (the token/code spec for agents). This is the
 * eyeball version.
 *
 * Follows the `/preview/*` convention: mounted outside `<Layout>` (no auth /
 * no router context needed), self-contained, theme-togglable via the header
 * control or `?theme=light|dark`. Unlike the other previews it is NOT gated by
 * `import.meta.env.DEV` — it ships so it can be opened on a deployed URL.
 */

// ── token catalogs ─────────────────────────────────────────────────────────

type SwatchDef = { name: string; token: string; note?: string };

// Canonical names = the short tokens the codebase actually uses. The parallel
// --color-text-* / --color-surface-* / --color-border-* alias layer is unadopted
// (see DESIGN-AUDIT.md P2), so the styleguide shows the real names.
const TEXT_COLORS: SwatchDef[] = [
  { name: "--fg", token: "var(--fg)", note: "primary ink" },
  { name: "--fg-2", token: "var(--fg-2)", note: "secondary" },
  { name: "--fg-3", token: "var(--fg-3)", note: "tertiary / hints" },
  { name: "--fg-4", token: "var(--fg-4)", note: "disabled" },
  { name: "--fg-on-vivid", token: "var(--fg-on-vivid)", note: "on color (no invert)" },
];

const SURFACE_COLORS: SwatchDef[] = [
  { name: "--bg", token: "var(--bg)", note: "page base" },
  { name: "--bg-raised", token: "var(--bg-raised)", note: "cards / panels" },
  { name: "--bg-sunken", token: "var(--bg-sunken)", note: "wells" },
  { name: "--bg-hover", token: "var(--bg-hover)" },
  { name: "--bg-active", token: "var(--bg-active)" },
];

const BORDER_COLORS: SwatchDef[] = [
  { name: "--border-faint", token: "var(--border-faint)", note: "subtle" },
  { name: "--border", token: "var(--border)", note: "default" },
  { name: "--border-strong", token: "var(--border-strong)", note: "emphasis" },
];

// Primary = the neutral action color (near-black ink in light, near-white in
// dark). Drives buttons, active tabs/rows, selection, links. Inverts by theme.
const PRIMARY_COLORS: SwatchDef[] = [
  { name: "--primary", token: "var(--primary)", note: "action ink" },
  { name: "--primary-hover", token: "var(--primary-hover)", note: "hover" },
  { name: "--primary-on", token: "var(--primary-on)", note: "text on primary" },
  { name: "--ring", token: "var(--ring)", note: "focus ring" },
];

// Brand = the signature green. Reserved for logo / tree nodes / mentions /
// success — never the generic button color.
const BRAND_COLORS: SwatchDef[] = [
  { name: "--brand", token: "var(--brand)", note: "signature green" },
  { name: "--brand-dim", token: "var(--brand-dim)", note: "pressed" },
  { name: "--brand-bg", token: "var(--brand-bg)", note: "tinted fill" },
  { name: "--brand-ring", token: "var(--brand-ring)", note: "selection band" },
];

const STATE_COLORS: SwatchDef[] = [
  { name: "--state-idle", token: "var(--state-idle)", note: "neutral standby" },
  { name: "--state-working", token: "var(--state-working)" },
  { name: "--state-blocked", token: "var(--state-blocked)" },
  { name: "--state-error", token: "var(--state-error)" },
  { name: "--state-offline", token: "var(--state-offline)" },
];

// Feedback / severity vocabulary — distinct names, aliased to shared base hues.
const FEEDBACK_COLORS: SwatchDef[] = [
  { name: "--success", token: "var(--success)", note: "= brand green" },
  { name: "--warning", token: "var(--warning)", note: "= blocked amber" },
  { name: "--danger", token: "var(--danger)", note: "= error red" },
];

const CALLOUT_COLORS: SwatchDef[] = [
  { name: "--color-error", token: "var(--color-error)", note: "text / border" },
  { name: "--color-error-soft", token: "var(--color-error-soft)", note: "fill" },
  { name: "--color-warn", token: "var(--color-warn)" },
  { name: "--color-warn-soft", token: "var(--color-warn-soft)" },
  { name: "--color-success", token: "var(--color-success)" },
  { name: "--color-success-soft", token: "var(--color-success-soft)" },
];

const AVATAR_HUES: SwatchDef[] = Array.from({ length: 8 }, (_, i) => ({
  name: `--avatar-hue-${i}`,
  token: `var(--avatar-hue-${i})`,
}));

type TypeTier = { cls: string; name: string; meta: string; sample: string; uppercase?: boolean };

// `meta` is "size / weight" in px-equivalent — no "px" suffix on purpose so the
// design-token guardrail (which bans digit+px literals in src) stays clean.
const APP_TIERS: TypeTier[] = [
  { cls: "text-eyebrow", name: "text-eyebrow", meta: "10 / 600 / +0.1em", sample: "Section eyebrow", uppercase: true },
  { cls: "text-caption", name: "text-caption", meta: "10 / 500", sample: "Dense caption metadata" },
  { cls: "text-label", name: "text-label", meta: "11 / 500", sample: "Form label / chip" },
  { cls: "text-body", name: "text-body", meta: "12 / 400", sample: "Body copy and button text." },
  { cls: "text-subtitle", name: "text-subtitle", meta: "13 / 600 · default", sample: "Row title / subtitle" },
  { cls: "text-title", name: "text-title", meta: "16 / 600", sample: "Section & page title" },
  { cls: "text-live", name: "text-live", meta: "32 / 600", sample: "Live" },
];

const MARKETING_TIERS: TypeTier[] = [
  { cls: "text-lead", name: "text-lead", meta: "18 / 400", sample: "Landing lead paragraph copy." },
  { cls: "text-headline", name: "text-headline", meta: "24 / 600", sample: "Landing section headline" },
  { cls: "text-display", name: "text-display", meta: "clamp 40–60 / 600", sample: "Hero display" },
];

// token name + the rem value (rem is guardrail-safe; px is not).
const SPACING: Array<{ name: string; rem: string }> = [
  { name: "--sp-0_5", rem: "0.125rem" },
  { name: "--sp-1", rem: "0.25rem" },
  { name: "--sp-1_5", rem: "0.375rem" },
  { name: "--sp-2", rem: "0.5rem" },
  { name: "--sp-3", rem: "0.75rem" },
  { name: "--sp-4", rem: "1rem" },
  { name: "--sp-6", rem: "1.5rem" },
  { name: "--sp-8", rem: "2rem" },
  { name: "--sp-12", rem: "3rem" },
  { name: "--sp-16", rem: "4rem" },
];

const RADII: Array<{ name: string; token: string; value: string }> = [
  { name: "--radius-chip", token: "var(--radius-chip)", value: "3" },
  { name: "--radius-input", token: "var(--radius-input)", value: "4" },
  { name: "--radius-panel", token: "var(--radius-panel)", value: "6" },
  { name: "--radius-dialog", token: "var(--radius-dialog)", value: "8" },
];

// ── layout helpers ───────────────────────────────────────────────────────────

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: "var(--sp-12)" }}>
      <div style={{ marginBottom: "var(--sp-4)" }}>
        <h2 className="text-title" style={{ color: "var(--fg)" }}>
          {title}
        </h2>
        {subtitle ? (
          <p className="text-body" style={{ color: "var(--fg-3)", marginTop: "var(--sp-0_5)" }}>
            {subtitle}
          </p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Subhead({ children }: { children: ReactNode }) {
  return (
    <div className="mono uppercase text-eyebrow" style={{ color: "var(--fg-4)", marginBottom: "var(--sp-2)" }}>
      {children}
    </div>
  );
}

function Row({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center" style={{ gap: "var(--sp-3)", marginBottom: "var(--sp-4)" }}>
      {children}
    </div>
  );
}

function Swatch({ name, token, note }: SwatchDef) {
  return (
    <div>
      <div
        style={{
          height: 52,
          borderRadius: "var(--radius-input)",
          border: "var(--hairline) solid var(--border)",
          background: token,
        }}
      />
      <div className="mono text-caption" style={{ color: "var(--fg-2)", marginTop: "var(--sp-1)" }}>
        {name}
      </div>
      {note ? (
        <div className="text-caption" style={{ color: "var(--fg-4)" }}>
          {note}
        </div>
      ) : null}
    </div>
  );
}

function SwatchGrid({ items }: { items: SwatchDef[] }) {
  return (
    <div
      className="grid"
      style={{
        gap: "var(--sp-3)",
        gridTemplateColumns: "repeat(auto-fill, minmax(8.5rem, 1fr))",
        marginBottom: "var(--sp-5)",
      }}
    >
      {items.map((s) => (
        <Swatch key={s.name} {...s} />
      ))}
    </div>
  );
}

function TierRow({ tier }: { tier: TypeTier }) {
  return (
    <div
      className="flex items-baseline"
      style={{
        gap: "var(--sp-4)",
        padding: "var(--sp-3) 0",
        borderBottom: "var(--hairline) solid var(--border-faint)",
      }}
    >
      <div className="mono text-caption shrink-0" style={{ color: "var(--fg-4)", width: "12rem" }}>
        <div style={{ color: "var(--fg-2)" }}>{tier.name}</div>
        <div>{tier.meta}</div>
      </div>
      <div className={`${tier.cls}${tier.uppercase ? " uppercase" : ""}`} style={{ color: "var(--fg)", minWidth: 0 }}>
        {tier.sample}
      </div>
    </div>
  );
}

// ── interactive demos (need local state) ─────────────────────────────────────

function SegmentedDemo() {
  const [value, setValue] = useState("list");
  return (
    <SegmentedControl
      value={value}
      onChange={setValue}
      options={[
        { value: "list", label: "List" },
        { value: "grid", label: "Grid" },
        { value: "tree", label: "Tree" },
      ]}
    />
  );
}

function TabsDemo() {
  const [tab, setTab] = useState("overview");
  return (
    <TabBar>
      <Tab active={tab === "overview"} onClick={() => setTab("overview")}>
        Overview
      </Tab>
      <Tab active={tab === "activity"} onClick={() => setTab("activity")}>
        Activity <TabBadge>3</TabBadge>
      </Tab>
      <Tab active={tab === "settings"} onClick={() => setTab("settings")}>
        Settings
      </Tab>
    </TabBar>
  );
}

function ToastDemo() {
  const { addToast } = useToast();
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() =>
        addToast({
          title: "Changes saved",
          description: "Your agent profile was updated.",
          action: { label: "Undo", onClick: () => undefined },
        })
      }
    >
      Show toast
    </Button>
  );
}

function PopoverDemo() {
  return (
    <Popover
      trigger={({ toggle, open }) => (
        <Button variant="outline" size="sm" onClick={toggle} aria-expanded={open}>
          Open popover
        </Button>
      )}
    >
      {({ close }) => (
        <div style={{ padding: "var(--sp-3)", width: 240 }}>
          <p className="text-body" style={{ color: "var(--fg-2)" }}>
            Anchored popover panel, portaled so an overflow-hidden ancestor can't clip it.
          </p>
          <Button variant="ghost" size="xs" onClick={close} style={{ marginTop: "var(--sp-2)" }}>
            Close
          </Button>
        </div>
      )}
    </Popover>
  );
}

function ThemeControl() {
  const [dark, setDark] = useState(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const override = params.get("theme");
    if (override === "light" || override === "dark") {
      const wantDark = override === "dark";
      document.documentElement.classList.toggle("dark", wantDark);
      setDark(wantDark);
    }
  }, []);

  const toggle = () => {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    window.localStorage.setItem("theme", next ? "dark" : "light");
    setDark(next);
  };

  return (
    <Button variant="outline" size="sm" onClick={toggle}>
      {dark ? "Light mode" : "Dark mode"}
    </Button>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

export function StyleguidePreviewPage() {
  return (
    <div style={{ background: "var(--bg)", minHeight: "100vh", padding: "var(--sp-8)" }}>
      <div style={{ maxWidth: 1120, margin: "0 auto" }}>
        <header
          className="flex items-start justify-between"
          style={{ gap: "var(--sp-4)", marginBottom: "var(--sp-10)" }}
        >
          <div>
            <h1 className="text-title" style={{ color: "var(--fg)" }}>
              First Tree · Design System
            </h1>
            <p className="text-body" style={{ color: "var(--fg-3)", marginTop: "var(--sp-1)", maxWidth: "42rem" }}>
              Live visual reference — rendered from the real tokens in <span className="mono">index.css</span> and the
              real <span className="mono">components/ui</span> primitives. Companion to{" "}
              <span className="mono">DESIGN.md</span>. Numbers shown without units are px-equivalent.
            </p>
          </div>
          <div className="shrink-0">
            <ThemeControl />
          </div>
        </header>

        {/* ─── Color ─────────────────────────────────────────────────────── */}
        <Section title="Color" subtitle="Semantic OkLCH tokens. Components reference intent, never raw hex.">
          <Subhead>Text</Subhead>
          <SwatchGrid items={TEXT_COLORS} />
          <Subhead>Surface</Subhead>
          <SwatchGrid items={SURFACE_COLORS} />
          <Subhead>Border</Subhead>
          <SwatchGrid items={BORDER_COLORS} />
          <Subhead>Primary (neutral action)</Subhead>
          <SwatchGrid items={PRIMARY_COLORS} />
          <Subhead>Brand (signature green)</Subhead>
          <SwatchGrid items={BRAND_COLORS} />
          <Subhead>State (agent vocabulary)</Subhead>
          <SwatchGrid items={STATE_COLORS} />
          <Subhead>Feedback / severity</Subhead>
          <SwatchGrid items={FEEDBACK_COLORS} />
          <Subhead>Callout pairs (soft fill + strong text/border)</Subhead>
          <SwatchGrid items={CALLOUT_COLORS} />
          <Subhead>Avatar hues</Subhead>
          <SwatchGrid items={AVATAR_HUES} />
        </Section>

        {/* ─── Typography ────────────────────────────────────────────────── */}
        <Section
          title="Typography"
          subtitle="Six dense tiers for app chrome; three marketing tiers for the landing page. Weights 400/500/600/700 only."
        >
          <Subhead>App scale</Subhead>
          <div style={{ marginBottom: "var(--sp-6)" }}>
            {APP_TIERS.map((t) => (
              <TierRow key={t.cls} tier={t} />
            ))}
          </div>
          <Subhead>Marketing scale</Subhead>
          <div>
            {MARKETING_TIERS.map((t) => (
              <TierRow key={t.cls} tier={t} />
            ))}
          </div>
        </Section>

        {/* ─── Spacing ───────────────────────────────────────────────────── */}
        <Section title="Spacing" subtitle="The --sp-* ladder (mirror of Tailwind's spacing). Bar width = the token.">
          <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
            {SPACING.map((s) => (
              <div key={s.name} className="flex items-center" style={{ gap: "var(--sp-3)" }}>
                <div className="mono text-caption shrink-0" style={{ color: "var(--fg-3)", width: "6rem" }}>
                  {s.name}
                </div>
                <div style={{ height: 12, width: `var(${s.name})`, background: "var(--primary)", borderRadius: 2 }} />
                <div className="mono text-caption" style={{ color: "var(--fg-4)" }}>
                  {s.rem}
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* ─── Radius ────────────────────────────────────────────────────── */}
        <Section title="Radius" subtitle="Semantic radii, ascending with surface importance.">
          <Row>
            {RADII.map((r) => (
              <div key={r.name} style={{ textAlign: "center" }}>
                <div
                  style={{
                    width: 72,
                    height: 72,
                    background: "var(--bg-raised)",
                    border: "var(--hairline) solid var(--border-strong)",
                    borderRadius: r.token,
                  }}
                />
                <div className="mono text-caption" style={{ color: "var(--fg-2)", marginTop: "var(--sp-1)" }}>
                  {r.name}
                </div>
                <div className="mono text-caption" style={{ color: "var(--fg-4)" }}>
                  {r.value}
                </div>
              </div>
            ))}
          </Row>
        </Section>

        {/* ─── Surfaces ──────────────────────────────────────────────────── */}
        <Section
          title="Surfaces & elevation"
          subtitle="Consolidated background + border + radius (+ shadow) utilities."
        >
          <Row>
            {["surface-raised", "surface-sunken", "surface-overlay"].map((cls) => (
              <div
                key={cls}
                className={cls}
                style={{ width: "14rem", height: 88, display: "grid", placeItems: "center" }}
              >
                <span className="mono text-caption" style={{ color: "var(--fg-3)" }}>
                  .{cls}
                </span>
              </div>
            ))}
          </Row>
        </Section>

        {/* ─── Buttons ───────────────────────────────────────────────────── */}
        <Section title="Buttons" subtitle="6 variants × 5 sizes, via class-variance-authority.">
          <Subhead>Variants</Subhead>
          <Row>
            <Button>Default</Button>
            <Button variant="destructive">Destructive</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="link">Link</Button>
            <Button disabled>Disabled</Button>
          </Row>
          <Subhead>Sizes</Subhead>
          <Row>
            <Button size="xs">Extra small</Button>
            <Button size="sm">Small</Button>
            <Button size="default">Default</Button>
            <Button size="lg">Large</Button>
          </Row>
        </Section>

        {/* ─── Badges & status ───────────────────────────────────────────── */}
        <Section title="Badges & status" subtitle="Badge, DenseBadge, and the agent status vocabulary.">
          <Subhead>Badge</Subhead>
          <Row>
            <Badge>Default</Badge>
            <Badge variant="secondary">Secondary</Badge>
            <Badge variant="destructive">Destructive</Badge>
            <Badge variant="outline">Outline</Badge>
          </Row>
          <Subhead>DenseBadge</Subhead>
          <Row>
            <DenseBadge tone="neutral">Neutral</DenseBadge>
            <DenseBadge tone="accent">Brand</DenseBadge>
            <DenseBadge tone="warn">Warn</DenseBadge>
            <DenseBadge tone="error">Error</DenseBadge>
            <DenseBadge tone="outline">Outline</DenseBadge>
          </Row>
          <Subhead>StateChip (runtime vocabulary)</Subhead>
          <Row>
            <StateChip state="idle" />
            <StateChip state="working" />
            <StateChip state="blocked" />
            <StateChip state="error" />
            <StateChip state="offline" />
          </Row>
          <Subhead>AgentStatusChip (composite vocabulary)</Subhead>
          <Row>
            <AgentStatusChip main="ready" />
            <AgentStatusChip main="working" />
            <AgentStatusChip main="needs_you" />
            <AgentStatusChip main="paused" />
            <AgentStatusChip main="failed" />
            <AgentStatusChip main="offline" />
          </Row>
          <Subhead>PresenceChip · StateDot · StatusGlyph</Subhead>
          <Row>
            <PresenceChip status="online" />
            <PresenceChip status="offline" />
            <span className="flex items-center" style={{ gap: "var(--sp-2)" }}>
              <StateDot state="idle" />
              <StateDot state="working" />
              <StateDot state="error" />
            </span>
            <span className="flex items-center" style={{ gap: "var(--sp-2)" }}>
              <StatusGlyph colorVar="var(--state-idle)" shape="dot" ariaLabel="dot" />
              <StatusGlyph colorVar="var(--state-offline)" shape="hollow" ariaLabel="hollow" />
              <StatusGlyph colorVar="var(--state-blocked)" shape="pause" ariaLabel="pause" />
              <StatusGlyph colorVar="var(--state-working)" shape="dot" pulse="working" ariaLabel="working pulse" />
              <StatusGlyph colorVar="var(--state-error)" shape="dot" pulse="needs-you" ariaLabel="needs-you pulse" />
            </span>
          </Row>
          <Subhead>FilterPill</Subhead>
          <Row>
            <FilterPill active>All</FilterPill>
            <FilterPill count={5}>Unread</FilterPill>
            <FilterPill warn count={2}>
              Failed
            </FilterPill>
          </Row>
        </Section>

        {/* ─── Form controls ─────────────────────────────────────────────── */}
        <Section title="Form controls" subtitle="Input, Label, SegmentedControl.">
          <div className="flex flex-col" style={{ gap: "var(--sp-2)", maxWidth: "22rem", marginBottom: "var(--sp-5)" }}>
            <Label htmlFor="sg-name">Agent name</Label>
            <Input id="sg-name" placeholder="e.g. kael" defaultValue="kael" />
            <Input placeholder="Disabled" disabled />
          </div>
          <Subhead>SegmentedControl</Subhead>
          <SegmentedDemo />
        </Section>

        {/* ─── Navigation ────────────────────────────────────────────────── */}
        <Section title="Navigation" subtitle="Breadcrumb, TabBar, SectionHeader.">
          <Subhead>Breadcrumb</Subhead>
          <div style={{ marginBottom: "var(--sp-5)" }}>
            <Breadcrumb>
              <BreadcrumbLink onClick={() => undefined}>Team</BreadcrumbLink>
              <BreadcrumbSep />
              <BreadcrumbLink onClick={() => undefined}>kael</BreadcrumbLink>
              <BreadcrumbSep />
              <BreadcrumbCurrent>Profile</BreadcrumbCurrent>
            </Breadcrumb>
          </div>
          <Subhead>TabBar</Subhead>
          <div style={{ marginBottom: "var(--sp-5)" }}>
            <TabsDemo />
          </div>
          <Subhead>SectionHeader</Subhead>
          <SectionHeader right={<UppercaseLabel style={{ color: "var(--fg-4)" }}>3 items</UppercaseLabel>}>
            Agents
          </SectionHeader>
        </Section>

        {/* ─── Containers ────────────────────────────────────────────────── */}
        <Section title="Containers" subtitle="Card, Panel, Tile.">
          <Row>
            <Card style={{ width: "20rem" }}>
              <CardHeader>
                <CardTitle>Card title</CardTitle>
                <CardDescription>A shadcn-shaped card on the panel radius.</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-body" style={{ color: "var(--fg-2)" }}>
                  Card body content goes here.
                </p>
              </CardContent>
            </Card>

            <Panel style={{ width: "20rem" }}>
              <PanelHeader>
                <PanelTitle>Panel title</PanelTitle>
                <Badge variant="secondary">beta</Badge>
              </PanelHeader>
              <PanelBody>
                <p className="text-body" style={{ color: "var(--fg-2)" }}>
                  Panel body — the token-native container used across settings.
                </p>
              </PanelBody>
            </Panel>
          </Row>
          <Subhead>Tile</Subhead>
          <Row>
            <Tile label="Agents" value="12" />
            <Tile label="Online" value="8" accent="var(--brand-dim)" />
            <Tile label="Failed" value="1" accent="var(--state-error)" />
          </Row>
        </Section>

        {/* ─── Overlays & feedback ───────────────────────────────────────── */}
        <Section title="Overlays & feedback" subtitle="Dialog, Popover, Toast.">
          <Row>
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm">
                  Open dialog
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Delete agent?</DialogTitle>
                  <DialogDescription>
                    This removes the agent and its bindings. This action cannot be undone.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="ghost" size="sm">
                      Cancel
                    </Button>
                  </DialogClose>
                  <DialogClose asChild>
                    <Button variant="destructive" size="sm">
                      Delete
                    </Button>
                  </DialogClose>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <PopoverDemo />
            <ToastDemo />
          </Row>
        </Section>

        {/* ─── Data ──────────────────────────────────────────────────────── */}
        <Section title="Data table" subtitle="The shared Table primitive.">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last active</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>kael</TableCell>
                <TableCell>
                  <StateChip state="working" />
                </TableCell>
                <TableCell className="mono">now</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>design-critique</TableCell>
                <TableCell>
                  <StateChip state="idle" />
                </TableCell>
                <TableCell className="mono">2m</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>research</TableCell>
                <TableCell>
                  <StateChip state="offline" />
                </TableCell>
                <TableCell className="mono">1h</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </Section>

        {/* ─── Marketing surface ─────────────────────────────────────────── */}
        <Section
          title="Marketing surface"
          subtitle="The .landing-marketing palette — pinned to the first-tree.ai brand regardless of the dashboard theme."
        >
          <div
            className="landing-marketing"
            style={{
              padding: "var(--sp-6)",
              borderRadius: "var(--radius-panel)",
              background: "var(--bg)",
              border: "var(--hairline) solid var(--border)",
            }}
          >
            <div className="text-eyebrow uppercase" style={{ color: "var(--brand)", marginBottom: "var(--sp-1)" }}>
              First Tree
            </div>
            <div className="text-headline" style={{ color: "var(--fg)" }}>
              The unified CLI for agent teams
            </div>
            <p className="text-body" style={{ color: "var(--fg-2)", marginTop: "var(--sp-2)", maxWidth: "32rem" }}>
              Same variable names as the dashboard, so every component utility inherits the brand palette inside this
              scope. The green brand is shared across all three palettes.
            </p>
            <div style={{ marginTop: "var(--sp-4)" }}>
              <Button size="sm">Get started</Button>
            </div>
          </div>
        </Section>
      </div>
    </div>
  );
}
