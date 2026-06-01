import { Check, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/utils.js";

/**
 * Themeable single-select control. Replaces native `<select>` (OS-controlled,
 * unstylable popups, inconsistent cross-platform) and the old per-page
 * `OptionDropdown`. Built as a button trigger + portal listbox so the panel
 * escapes `overflow: hidden` ancestors and matches the trigger width.
 *
 * Trigger is a bordered control, so per DESIGN.md §13 focus deepens its border
 * to `--ring` (no ring, no double frame). The open panel is a `role=listbox`
 * driven by `aria-activedescendant`: full keyboard support (arrows, Home/End,
 * type-ahead, Enter, Escape) with menu-style background highlight on the active
 * option rather than a focus ring. Optional `searchable` adds a filter input.
 */
export type SelectOption = {
  value: string;
  label: string;
  /** Right-aligned muted sub-label (e.g. a model's context window). */
  hint?: string;
  disabled?: boolean;
};

export type SelectProps = {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  /** Shown on the trigger when no option matches `value`. */
  placeholder?: string;
  /** Adds a filter input above the list — use for long option sets. */
  searchable?: boolean;
  /** Monospace the trigger + options (model ids, transports, ...). */
  mono?: boolean;
  id?: string;
  "aria-label"?: string;
  className?: string;
  triggerClassName?: string;
};

export function Select({
  value,
  onChange,
  options,
  disabled,
  placeholder,
  searchable,
  mono,
  id,
  "aria-label": ariaLabel,
  className,
  triggerClassName,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [rect, setRect] = useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
  } | null>(null);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const typeahead = useRef<{ buffer: string; timer: number | null }>({ buffer: "", timer: null });
  // Latest options/value, read by the open-init effect so it keys on `open`
  // alone — callers pass freshly-built option arrays each render, and we must
  // NOT reset query / active index just because that identity changed.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const valueRef = useRef(value);
  valueRef.current = value;

  const baseId = useId();
  const selected = options.find((o) => o.value === value);

  const visible = useMemo(() => {
    if (!searchable || !query) return options;
    const q = query.toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q));
  }, [options, searchable, query]);

  // Anchor under the trigger, flipping above and clamping the list height when
  // the trigger sits low in the viewport (a row near the page bottom).
  const computePosition = useCallback(() => {
    const t = triggerRef.current;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const gap = 4;
    const below = window.innerHeight - r.bottom - gap;
    const above = r.top - gap;
    const openUp = below < 200 && above > below;
    const space = openUp ? above : below;
    const maxHeight = Math.max(96, Math.min(280, space - 4));
    setRect(
      openUp
        ? { left: r.left, width: r.width, bottom: window.innerHeight - r.top + gap, maxHeight }
        : { left: r.left, width: r.width, top: r.bottom + gap, maxHeight },
    );
  }, []);

  const closeAndFocus = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // Focus the open panel so it captures keyboard events. Stable callback refs
  // fire only on mount/unmount (not on every reflow re-render). In searchable
  // mode the search input takes focus; otherwise the listbox div does.
  const focusListOnMount = useCallback(
    (node: HTMLDivElement | null) => {
      listRef.current = node;
      if (node && !searchable) node.focus();
    },
    [searchable],
  );
  const focusInputOnMount = useCallback((node: HTMLInputElement | null) => {
    node?.focus();
  }, []);

  // Anchor + seed the active option when opening. Keyed on `open` only;
  // options/value are read from refs so a parent re-render (e.g. a query
  // refetch rebuilding the options array) does not wipe in-progress state.
  useLayoutEffect(() => {
    if (!open) return;
    computePosition();
    const opts = optionsRef.current;
    const firstEnabled = opts.findIndex((o) => !o.disabled);
    const sel = opts.findIndex((o) => o.value === valueRef.current);
    setActiveIndex(sel >= 0 ? sel : firstEnabled >= 0 ? firstEnabled : 0);
    setQuery("");
    typeahead.current.buffer = "";
  }, [open, computePosition]);

  // Keep activeIndex inside the (possibly filtered) visible range and on an
  // enabled option, so aria-activedescendant and Enter never target a missing
  // or disabled row after the list narrows.
  useEffect(() => {
    setActiveIndex((cur) => {
      if (visible.length === 0) return 0;
      if (cur >= 0 && cur < visible.length && !visible[cur]?.disabled) return cur;
      const firstEnabled = visible.findIndex((o) => !o.disabled);
      return firstEnabled >= 0 ? firstEnabled : Math.min(Math.max(cur, 0), visible.length - 1);
    });
  }, [visible]);

  // Clear any pending type-ahead timer on unmount.
  useEffect(() => {
    return () => {
      if (typeahead.current.timer) window.clearTimeout(typeahead.current.timer);
    };
  }, []);

  // Outside-click, reflow, and global Escape (covers the search input too).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    // Coalesce scroll/resize bursts into one reposition per frame so a fling
    // scroll with the panel open doesn't force a layout read on every event.
    let raf = 0;
    const onReflow = (): void => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        computePosition();
      });
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [open, computePosition]);

  const commit = useCallback(
    (opt: SelectOption | undefined): void => {
      if (!opt || opt.disabled) return;
      onChange(opt.value);
      closeAndFocus();
    },
    [onChange, closeAndFocus],
  );

  const moveActive = useCallback(
    (dir: 1 | -1): void => {
      if (visible.length === 0) return;
      setActiveIndex((cur) => {
        let next = cur;
        for (let i = 0; i < visible.length; i++) {
          next = (next + dir + visible.length) % visible.length;
          if (!visible[next]?.disabled) break;
        }
        return next;
      });
    },
    [visible],
  );

  const onListKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          moveActive(1);
          break;
        case "ArrowUp":
          e.preventDefault();
          moveActive(-1);
          break;
        case "Home":
          e.preventDefault();
          setActiveIndex(visible.findIndex((o) => !o.disabled));
          break;
        case "End":
          e.preventDefault();
          for (let i = visible.length - 1; i >= 0; i--) {
            if (!visible[i]?.disabled) {
              setActiveIndex(i);
              break;
            }
          }
          break;
        case "Enter":
          e.preventDefault();
          commit(visible[activeIndex]);
          break;
        case "Tab":
          closeAndFocus();
          break;
        case "Escape":
          e.preventDefault();
          closeAndFocus();
          break;
        default:
          // Type-ahead (only when not using the search input).
          if (!searchable && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const ta = typeahead.current;
            ta.buffer += e.key.toLowerCase();
            if (ta.timer) window.clearTimeout(ta.timer);
            ta.timer = window.setTimeout(() => {
              ta.buffer = "";
            }, 600);
            const match = visible.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(ta.buffer));
            if (match >= 0) setActiveIndex(match);
          }
          break;
      }
    },
    [moveActive, commit, closeAndFocus, visible, activeIndex, searchable],
  );

  const onTriggerKeyDown = (e: React.KeyboardEvent): void => {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      setOpen(true);
    }
  };

  const listboxId = `${baseId}-listbox`;
  const optionId = (i: number): string => `${baseId}-opt-${i}`;

  return (
    <div className={cn("max-w-md", className)}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          "flex h-9 w-full cursor-pointer items-center justify-between rounded-[var(--radius-input)] border border-input bg-transparent pl-3 pr-2 py-1 text-body transition-colors hover:border-ring focus-visible:outline-none focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50",
          mono && "mono",
          triggerClassName,
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
      >
        <span className="truncate" style={{ color: selected ? undefined : "var(--fg-3)" }}>
          {selected?.label ?? placeholder ?? value}
        </span>
        <ChevronDown
          className="ml-2 h-3.5 w-3.5 transition-transform"
          style={{ color: "var(--fg-3)", transform: open ? "rotate(180deg)" : undefined }}
        />
      </button>
      {open &&
        rect &&
        createPortal(
          <div
            ref={panelRef}
            className="fixed z-50 flex flex-col overflow-hidden rounded-[var(--radius-input)]"
            style={{
              top: rect.top,
              bottom: rect.bottom,
              left: rect.left,
              width: rect.width,
              background: "var(--bg-raised)",
              border: "var(--hairline) solid var(--border)",
              boxShadow: "var(--shadow-md)",
            }}
          >
            {searchable && (
              <input
                ref={focusInputOnMount}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onListKeyDown}
                placeholder="Search…"
                role="combobox"
                aria-expanded={open}
                aria-controls={listboxId}
                aria-autocomplete="list"
                aria-activedescendant={visible[activeIndex] ? optionId(activeIndex) : undefined}
                className="w-full shrink-0 border-b border-border bg-transparent px-3 py-2 text-body outline-none placeholder:text-muted-foreground"
              />
            )}
            <div
              ref={focusListOnMount}
              id={listboxId}
              role="listbox"
              aria-label={ariaLabel}
              aria-activedescendant={visible[activeIndex] ? optionId(activeIndex) : undefined}
              tabIndex={-1}
              onKeyDown={searchable ? undefined : onListKeyDown}
              className="py-1 outline-none"
              style={{ maxHeight: rect.maxHeight, overflowY: "auto" }}
            >
              {visible.length === 0 && <div className="px-3 py-1.5 text-body text-muted-foreground">No matches</div>}
              {visible.map((o, i) => {
                const isSelected = o.value === value;
                const isActive = i === activeIndex;
                return (
                  <button
                    key={o.value || "__unset"}
                    id={optionId(i)}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    disabled={o.disabled}
                    tabIndex={-1}
                    onClick={() => commit(o)}
                    onMouseEnter={() => !o.disabled && setActiveIndex(i)}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2 bg-transparent px-3 py-1.5 text-body text-left transition-colors focus-visible:outline-none",
                      mono && "mono",
                      isActive && "bg-accent text-accent-foreground",
                      o.disabled && "cursor-not-allowed opacity-50",
                    )}
                    style={{ color: o.value === "" ? "var(--fg-3)" : undefined }}
                  >
                    <Check
                      className="h-3.5 w-3.5 flex-shrink-0"
                      style={{ visibility: isSelected ? "visible" : "hidden", color: "var(--success)" }}
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
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
