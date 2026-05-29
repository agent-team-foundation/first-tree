import type { RuntimeProvider } from "@first-tree/shared";
import { Check, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "../../components/ui/button.js";
import { ConfigRow } from "./flat-section.js";

/**
 * Model — an inline dropdown with a "changed" hint and Revert. No inline save:
 * the page Save Bar handles submission.
 */

export type ModelOption = { value: string; label: string; hint?: string };

export const CLAUDE_MODEL_OPTIONS: ModelOption[] = [
  { value: "opus", label: "opus", hint: "most capable" },
  { value: "sonnet", label: "sonnet", hint: "balanced" },
  { value: "haiku", label: "haiku", hint: "fastest" },
];

/**
 * Codex CLI model slugs baked into `@openai/codex@0.125.0` — extracted from
 * the bundled binary's config schema. ChatGPT-account auth restricts which
 * are usable at runtime (gpt-5.5 works; older slugs reject); API-key auth
 * accepts the wider set. The picker lists all and lets the runtime surface
 * actual permission errors instead of pre-validating per auth mode.
 */
export const CODEX_MODEL_OPTIONS: ModelOption[] = [
  { value: "gpt-5.5", label: "gpt-5.5", hint: "latest" },
  { value: "gpt-5.4", label: "gpt-5.4" },
  { value: "gpt-5.4-mini", label: "gpt-5.4-mini", hint: "fastest" },
  { value: "gpt-5.3-codex", label: "gpt-5.3-codex", hint: "coding-specialized" },
  { value: "gpt-5.2", label: "gpt-5.2" },
];

const MODEL_OPTIONS_BY_PROVIDER: Record<RuntimeProvider, ModelOption[]> = {
  "claude-code": CLAUDE_MODEL_OPTIONS,
  "claude-code-tui": CLAUDE_MODEL_OPTIONS,
  codex: CODEX_MODEL_OPTIONS,
};

const MODEL_HELP_BY_PROVIDER: Record<RuntimeProvider, string> = {
  "claude-code": "Applies to new sessions immediately. Unset falls back to the CLI default.",
  "claude-code-tui": "Applies to new sessions immediately. Model swap restarts the tmux session (~2–4s).",
  codex: "Applies to new sessions immediately. Unset lets the CLI pick by auth mode.",
};

export type ModelSectionProps = {
  value: string;
  baseline: string;
  onChange: (v: string) => void;
  onRevert: () => void;
  disabled?: boolean;
  /** Runtime this agent runs on — drives the option list and help copy. */
  provider?: RuntimeProvider;
};

const UNSET_OPTION: ModelOption = { value: "", label: "(unset — inherits local)" };

export function ModelSection({
  value,
  baseline,
  onChange,
  onRevert,
  disabled,
  provider = "claude-code",
}: ModelSectionProps) {
  const dirty = value !== baseline;
  const presetOptions = MODEL_OPTIONS_BY_PROVIDER[provider];

  const items = useMemo<ModelOption[]>(() => {
    const list: ModelOption[] = [UNSET_OPTION, ...presetOptions];
    if (value !== "" && !presetOptions.some((o) => o.value === value)) {
      list.push({ value, label: value, hint: "custom" });
    }
    return list;
  }, [presetOptions, value]);

  return (
    <ConfigRow
      label="Model"
      helpText={MODEL_HELP_BY_PROVIDER[provider]}
      meta={dirty ? <ChangedChip /> : null}
      action={
        dirty ? (
          <Button size="xs" variant="ghost" onClick={onRevert} disabled={disabled}>
            Revert
          </Button>
        ) : null
      }
    >
      <ModelDropdown items={items} value={value} onChange={onChange} disabled={disabled} />
    </ConfigRow>
  );
}

function ChangedChip() {
  return (
    <span
      className="mono uppercase text-caption"
      style={{
        padding: "var(--hairline) var(--sp-1_5)",
        borderRadius: "var(--radius-chip)",
        background: "color-mix(in oklch, var(--state-blocked) 16%, transparent)",
        color: "color-mix(in oklch, var(--state-blocked) 60%, var(--fg))",
      }}
    >
      changed
    </span>
  );
}

/**
 * Custom listbox-style dropdown — built on top of a button + absolutely
 * positioned listbox so we can theme the popup (native `<select>` popups are
 * OS-controlled and unstylable). Anchors to the trigger via `top: 100%`,
 * dismisses on click-outside or Escape.
 */
function ModelDropdown({
  items,
  value,
  onChange,
  disabled,
}: {
  items: ModelOption[];
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [popupRect, setPopupRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const selected = items.find((o) => o.value === value) ?? items[0];

  const computePosition = useCallback(() => {
    const t = triggerRef.current;
    if (!t) return;
    const r = t.getBoundingClientRect();
    setPopupRect({ top: r.bottom + 4, left: r.left, width: r.width });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    computePosition();
  }, [open, computePosition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (popupRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onReflow = () => computePosition();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [open, computePosition]);

  return (
    <div className="max-w-md">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="mono flex h-9 w-full items-center justify-between rounded-[var(--radius-input)] border border-input bg-transparent pl-3 pr-2 py-1 text-body shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 hover:border-ring transition-colors cursor-pointer"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="truncate" style={{ color: selected?.value === "" ? "var(--fg-3)" : undefined }}>
          {selected?.label ?? value}
        </span>
        <ChevronDown
          className="ml-2 h-3.5 w-3.5 transition-transform"
          style={{ color: "var(--fg-3)", transform: open ? "rotate(180deg)" : undefined }}
        />
      </button>
      {open &&
        popupRect &&
        createPortal(
          <div
            ref={popupRef}
            className="fixed z-50 overflow-hidden rounded-[var(--radius-input)] py-1"
            style={{
              top: popupRect.top,
              left: popupRect.left,
              width: popupRect.width,
              background: "var(--bg-raised)",
              border: "var(--hairline) solid var(--border)",
              boxShadow: "var(--shadow-md)",
              maxHeight: 280,
              overflowY: "auto",
            }}
          >
            {items.map((o) => {
              const active = o.value === value;
              return (
                <button
                  key={o.value || "__unset"}
                  type="button"
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className="mono flex w-full items-center gap-2 cursor-pointer px-3 py-1.5 text-body text-left hover:bg-accent/40 transition-colors focus-visible:outline-none focus-visible:bg-accent/40"
                  style={{
                    background: active ? "var(--bg-hover)" : undefined,
                    color: o.value === "" ? "var(--fg-3)" : undefined,
                  }}
                >
                  <Check
                    className="h-3.5 w-3.5 flex-shrink-0"
                    style={{ visibility: active ? "visible" : "hidden", color: "var(--state-idle)" }}
                  />
                  <span className="flex-1 truncate">{o.label}</span>
                  {o.hint && (
                    <span className="text-caption" style={{ color: "var(--fg-4)" }}>
                      {o.hint}
                    </span>
                  )}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
