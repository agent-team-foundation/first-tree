import { Github } from "lucide-react";
import { LINKS } from "../content/links.js";

const NAV_LINKS: Array<{ label: string; href: string }> = [
  { label: "Agents", href: "#agents" },
  { label: "Docs", href: LINKS.docs },
  { label: "GitHub", href: LINKS.repo },
];

export function StickyNav() {
  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        backdropFilter: "blur(12px)",
        background: "color-mix(in oklab, var(--m-bg) 78%, transparent)",
        borderBottom: "var(--m-hairline) solid var(--m-border-faint)",
      }}
    >
      <div
        className="m-shell"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: 60,
        }}
      >
        <a
          href="#top"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--m-sp-2)",
            fontWeight: 600,
            fontSize: 15,
          }}
        >
          <BrandMark />
          <span>First Tree Hub</span>
        </a>
        <nav style={{ display: "flex", alignItems: "center", gap: "var(--m-sp-5)" }}>
          {NAV_LINKS.map((l) => (
            <a
              key={l.label}
              href={l.href}
              style={{ color: "var(--m-fg-3)", fontSize: 14 }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--m-fg)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--m-fg-3)";
              }}
            >
              {l.label}
            </a>
          ))}
          <a
            href={LINKS.repo}
            target="_blank"
            rel="noreferrer"
            className="m-btn m-btn--primary"
            style={{ padding: "8px 16px", fontSize: 13 }}
          >
            <Github size={14} />
            Star on GitHub
          </a>
        </nav>
      </div>
    </header>
  );
}

function BrandMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" role="img" aria-label="First Tree Hub logo">
      <defs>
        <linearGradient id="bm" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--m-accent)" />
          <stop offset="100%" stopColor="var(--m-violet)" />
        </linearGradient>
      </defs>
      <circle cx="11" cy="11" r="9" fill="none" stroke="url(#bm)" strokeWidth="1.6" />
      <path d="M11 4v14M4 11h14" stroke="url(#bm)" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
