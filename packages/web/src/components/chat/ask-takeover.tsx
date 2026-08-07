/**
 * AskTakeover — the pop-up answer card for a `format="request"` ask that blocks
 * THIS chat for the viewer. Rendered as a scrim + centered card INSIDE the
 * workspace body (the message list + composer area), so the topic header and the
 * right rail stay visible around it. One ask per card:
 *
 *   - the ask body (`content`, rendered as markdown) and the answer surface
 *     below it — 2–4 option cards (single = radio, multi = checkbox; each shows
 *     label + description, and `preview` when selected) plus an always-present
 *     free-text "Other" input, or a single free-text box when the ask carries no
 *     options — share ONE scrolling region, so a long ask plus many options can
 *     never push the controls off-screen;
 *   - Skip / Ask agent / Submit are pinned in a fixed footer below that scroll
 *     region, so Submit stays reachable at any viewport height (notably on phones,
 *     where the card is short and the answer surface used to overflow past the
 *     bottom edge with no way to scroll to it). Submit and Skip both RESOLVE the
 *     question; Ask agent swaps the answer surface into a clarification
 *     composer that keeps the question open. The card has no close control:
 *     the host may supply `onShowEarlierChat`, an explicit HIDE that shrinks
 *     the card into the composer's pending-question affordance and reveals
 *     the conversation (narrowed to the viewer ↔ asker pair) behind it.
 *
 * The free-text answer surface mirrors the chat composer: it supports `@mention`
 * autocomplete (against chat speakers plus host-supplied inviteable agents) and
 * attachments (paste / drop / file-picker), so answering an ask is as
 * expressive as a normal message. The
 * readable answer is still plain text (`buildResolveAnswer`: selected option
 * labels join on one line, any typed note follows); the host turns the assembled
 * {content, mentions, images, attachments} into the resolving reply. This is
 * the ONLY way to resolve a question: the target human answers here, in the web
 * UI; an agent can only ask, never answer or close.
 */
import type { AskOption, AskRequest, AttachmentKind, ContextDecision, MentionParticipant } from "@first-tree/shared";
import { COMPOSER_ACCEPT_ATTRIBUTE, extractMentions } from "@first-tree/shared";
import { AtSign, History, Paperclip, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useWorkspaceViewport } from "../../hooks/use-viewport.js";
import { usePendingAttachments } from "../../lib/use-pending-attachments.js";
import {
  composerPickerVisible,
  MentionAutocompletePopover,
  type MentionCandidate,
  useMentionAutocomplete,
} from "../mention-autocomplete.js";
import { MentionHighlightOverlay } from "../mention-highlight-overlay.js";
import { FileChip } from "../ui/file-chip.js";
import { Markdown, type MarkdownProps } from "../ui/markdown.js";
import { useMentionComposer } from "../use-mention-composer.js";
import type { AskAgentExchange } from "./ask-agent-state.js";
import { ContextDecisionReceipt } from "./context-decision-receipt.js";
import { ImageRefGallery, type ReferencedImage } from "./image-ref-gallery.js";
import { allRequiredAnswered, buildResolveAnswer } from "./request-state.js";

/**
 * The composed answer handed back to the host on Reply. The host owns the
 * actual send + resolve (it has the chat/request context and the upload
 * machinery); this card only assembles the answer.
 *
 *   - `content` — the readable answer (`buildResolveAnswer`): selected option
 *     labels and/or the typed note.
 *   - `mentions` — agentIds the free-text `@<name>` tokens resolved to (against
 *     `mentionCandidates`); the host routes the resolving reply to the asker
 *     PLUS these.
 *   - `images` — staged image files to upload + attach; a non-empty list makes
 *     the resolving reply a `format="file"` message (which the server resolves
 *     just like a text answer — the resolve gate is format-agnostic).
 *   - `attachments` — staged non-image files to upload as generic
 *     `metadata.attachments`; omitted when empty so existing image-only hosts
 *     keep their exact shape.
 */
export type AskAnswerAttachment = {
  file: File;
  kind: AttachmentKind;
};

export type AskAnswer = {
  content: string;
  mentions: string[];
  images: File[];
  attachments?: AskAnswerAttachment[];
};

type AskTakeoverDraft = {
  selected: string[];
  freeText: string;
  attachments: AskAnswerAttachment[];
};

const askTakeoverDrafts = new Map<string, AskTakeoverDraft>();
const MAX_ASK_TAKEOVER_DRAFTS = 20;

function saveAskTakeoverDraft(requestId: string, draft: AskTakeoverDraft): void {
  // Files can be large, so keep this cross-route in-memory cache bounded. The
  // current request is refreshed to the newest position before old drafts are
  // evicted.
  askTakeoverDrafts.delete(requestId);
  askTakeoverDrafts.set(requestId, draft);
  while (askTakeoverDrafts.size > MAX_ASK_TAKEOVER_DRAFTS) {
    const oldest = askTakeoverDrafts.keys().next().value;
    if (typeof oldest !== "string") break;
    askTakeoverDrafts.delete(oldest);
  }
}

/** Drop the request-scoped draft after a successful Submit/Skip resolution. */
export function clearAskTakeoverDraft(requestId: string): void {
  askTakeoverDrafts.delete(requestId);
}

/**
 * Height (px) the on-screen keyboard currently steals from the bottom of the
 * layout viewport, via the `visualViewport` API. Zero on desktop and whenever
 * no keyboard is up. The card lifts its bottom by this much so the pinned
 * Skip/Reply footer never hides behind a phone keyboard while the Other box is
 * focused. Robust across both mobile resize models: when the browser shrinks
 * the layout viewport instead (Android `resizes-content`), `innerHeight` falls
 * with `visualViewport.height` and the overlap computes to ~0 on its own.
 */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = typeof window === "undefined" ? undefined : window.visualViewport;
    if (!vv) return;
    const update = () => {
      const overlap = window.innerHeight - vv.height - vv.offsetTop;
      setInset(overlap > 1 ? overlap : 0);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}

export function AskTakeover({
  requestId,
  body,
  images = [],
  contextDecision = null,
  gitlabInstanceOrigin = null,
  payload,
  askerName,
  sending = false,
  mentionCandidates = [],
  markdownComponents,
  error,
  askAgent,
  onReply,
  onSkip,
  onShowEarlierChat,
  isTrial = false,
  mobile = false,
}: {
  /** Stable request id used to preserve answer text/options across inspect close/reopen. */
  requestId?: string;
  /** Trial surface: match the minimal trial composer — no @mention / attach
   *  affordances in the answer input, just plain text. */
  isTrial?: boolean;
  /** Touch surface (the mobile route): enlarge tap targets to the touch
   *  minimum and make Enter insert a newline (Reply button is the only submit),
   *  matching the mobile chat composer. */
  mobile?: boolean;
  /** The ask itself — the request message's markdown body. */
  body: string;
  /** Images attached to the ask, shown beneath the body in the same scroller. */
  images?: readonly ReferencedImage[];
  /**
   * The asking agent's Context Tree receipt for THIS question, when it reported
   * one. Rendered after the question body and before the answer controls: it is
   * context for the decision the human is about to make, never a second thing
   * to answer. It adds no request state, notification, or blocking condition.
   */
  contextDecision?: ContextDecision | null;
  /** Team GitLab web origin, forwarded to the receipt's source links. */
  gitlabInstanceOrigin?: string | null;
  payload: AskRequest;
  askerName?: string;
  sending?: boolean;
  /** Chat members the free-text `@` autocomplete suggests + resolves against
   *  (self-excluded, same source as the composer). Empty → no autocomplete and
   *  every `@<token>` stays plain text. */
  mentionCandidates?: MentionCandidate[];
  /** Host-provided link presentation shared with the message timeline. */
  markdownComponents?: MarkdownProps["components"];
  /** A host-side send failure to surface in the card (the composer is covered,
   *  so a failed resolve must show here or it looks like nothing happened). */
  error?: string;
  /** Shrink the card into the composer's pending-question affordance and show
   *  the conversation behind it, narrowed to the viewer ↔ asker pair. This is
   *  a HIDE, not a close — the question stays open and the bottom affordance
   *  reopens this card. Also wired to Escape. The card deliberately has no
   *  close/X control: "close" mis-states what happens to an unresolved ask. */
  onShowEarlierChat?: () => void;
  /** Optional request clarification controller shared by Chat and Need you. */
  askAgent?: {
    exchanges: AskAgentExchange[];
    waiting: boolean;
    sending: boolean;
    error: string | null;
    onAsk: (question: string) => Promise<void>;
  };
  /** Resolve the question with the composed answer. */
  onReply: (answer: AskAnswer) => void;
  /** Resolve the question with a "skipped" answer (caller sends the reply). */
  onSkip: () => void;
}) {
  const options = payload.options;
  const multi = payload.multiSelect === true;
  const initialDraft = requestId ? askTakeoverDrafts.get(requestId) : undefined;
  const [selected, setSelected] = useState<string[]>(initialDraft?.selected ?? []);
  const [freeText, setFreeText] = useState(initialDraft?.freeText ?? "");
  const [cursor, setCursor] = useState(0);
  const [askAgentOpen, setAskAgentOpen] = useState(false);
  const [askAgentDraft, setAskAgentDraft] = useState("");
  const [askAgentLocalError, setAskAgentLocalError] = useState<string | null>(null);
  const scrollRegionRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const askAgentInputRef = useRef<HTMLTextAreaElement>(null);
  // Tighten the horizontal padding on phone widths so the card uses the
  // available width instead of burning it on gutters. Note this keys off the
  // measured *viewport width*, whereas the touch-target / Enter behavior keys
  // off the `mobile` *route* prop — two intentionally distinct axes (a narrow
  // desktop window wants tighter gutters but not phone-sized tap targets).
  const viewport = useWorkspaceViewport();
  const padX = viewport === "narrow" ? "var(--sp-4)" : "var(--sp-6)";
  // Keep the card (and its pinned footer) above the on-screen keyboard.
  const keyboardInset = useKeyboardInset();
  const interactionLocked = sending || askAgent?.sending === true || askAgent?.waiting === true;

  // The normal shortcut listener below runs in the bubble phase so focused
  // mention/autocomplete controls can claim their own keystrokes first. While
  // a resolve or clarification is in flight, however, Escape must be frozen
  // before any page/document-level handler can interpret it as navigation.
  // Install this narrow capture-phase fence synchronously with the locked DOM:
  // `preventDefault` alone is too late once a host listener has already closed
  // the review surface.
  useLayoutEffect(() => {
    if (!interactionLocked) return;
    const blockEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (cardRef.current?.closest('[aria-hidden="true"]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", blockEscape, true);
    return () => window.removeEventListener("keydown", blockEscape, true);
  }, [interactionLocked]);

  useEffect(() => {
    if (!askAgentOpen) return;
    const timer = window.setTimeout(() => askAgentInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [askAgentOpen]);

  useEffect(() => {
    cardRef.current?.focus({ preventScroll: true });
  }, []);

  // Staged attachments — same hook (and same allowlist + attachment-cap rules
  // + object-URL lifecycle) the chat composer uses. A local validation error
  // renders alongside any host send error below.
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const { pendingAttachments, addFiles, removeAttachment } = usePendingAttachments({
    onError: setAttachmentError,
    onChange: () => setAttachmentError(null),
    initialAttachments: initialDraft?.attachments,
  });
  const pendingImages = useMemo(() => pendingAttachments.filter((att) => att.kind === "image"), [pendingAttachments]);
  const pendingDocs = useMemo(() => pendingAttachments.filter((att) => att.kind !== "image"), [pendingAttachments]);

  useEffect(() => {
    if (!requestId) return;
    saveAskTakeoverDraft(requestId, {
      selected,
      freeText,
      attachments: pendingAttachments.map(({ file, kind }) => ({ file, kind })),
    });
  }, [freeText, pendingAttachments, requestId, selected]);

  // Self-excluded membership projection for `@` resolution + the mirror overlay.
  const mentionParticipants = useMemo<MentionParticipant[]>(
    () => mentionCandidates.map((c) => ({ agentId: c.agentId, name: c.name })),
    [mentionCandidates],
  );

  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Display-side composer model (see mention-composer-model.ts): the answer
  // box shows `@<displayName>` for committed mentions while `freeText` stays
  // the canonical `@<name>` text that `reply()` (buildResolveAnswer +
  // extractMentions) and the request-scoped draft cache already consume.
  const mentionComposer = useMentionComposer({
    canonical: freeText,
    onCanonicalChange: setFreeText,
    candidates: mentionCandidates,
    // The card is keyed by request id in chat, but Need You reuses one
    // component across requests — reset the display model per request.
    scope: requestId,
  });

  const mention = useMentionAutocomplete({
    value: mentionComposer.displayText,
    cursor,
    candidates: mentionCandidates,
    disabled: interactionLocked,
    tokens: mentionComposer.tokens,
    onSelect: (_update, candidate, trigger) => {
      // Token-model commit: the visible text gets `@<displayName>` while the
      // canonical slug/agentId rides along as a token (the legacy `@<name>`
      // insertion in `_update` is intentionally unused).
      const applied = mentionComposer.applyPick(trigger, cursor, candidate);
      if (!applied) return;
      setCursor(applied.cursor);
      // Defer so React commits the new value before we move the selection —
      // otherwise the textarea snaps back to its old caret position.
      requestAnimationFrame(() => {
        const el = taRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(applied.cursor, applied.cursor);
      });
    },
  });

  const toggle = (label: string) => {
    if (interactionLocked) return;
    setSelected((prev) => {
      if (multi) return prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label];
      return prev.includes(label) ? [] : [label];
    });
  };

  // An attachment is itself an answer, so it lifts the "must select or type"
  // gate even on a free-text ask with an empty box.
  const canReply =
    (allRequiredAnswered(payload, selected, freeText) || pendingAttachments.length > 0) && !interactionLocked;
  // Memoized so the window-level keydown effect below has a stable dep (it would
  // otherwise re-bind the listener every render).
  const reply = useCallback(() => {
    if (!canReply) return;
    onReply({
      content: buildResolveAnswer(payload, selected, freeText),
      mentions: extractMentions(freeText, mentionParticipants),
      images: pendingImages.map((p) => p.file),
      ...(pendingDocs.length > 0 ? { attachments: pendingDocs.map((p) => ({ file: p.file, kind: p.kind })) } : {}),
    });
  }, [canReply, onReply, payload, selected, freeText, mentionParticipants, pendingImages, pendingDocs]);

  // Insert `@` at the caret (or over the selection) and refocus — the
  // autocomplete picks it up from the resulting value/cursor, same path as
  // typing `@`. Mirrors the composer's explicit `@` button.
  const insertMentionTrigger = () => {
    if (interactionLocked) return;
    const el = taRef.current;
    const text = mentionComposer.displayText;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? start;
    const next = `${text.slice(0, start)}@${text.slice(end)}`;
    mentionComposer.replaceDisplay(next);
    setCursor(start + 1);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + 1, start + 1);
    });
  };

  // Keyboard shortcuts, mirroring the chat composer: Enter (no Shift, and not
  // mid-IME-composition) resolves with Reply, while Shift+Enter stays a newline
  // in the free-text box. Escape may close the clarification editor or invoke
  // an explicitly non-resolving host action; it never resolves the request.
  // Bound at the window as a backstop for card-level focus.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      // A focused control already claimed this keystroke (e.g. the free-text
      // box's mention popover, which preventDefaults Enter/Escape to drive
      // selection). Don't also resolve the ask behind it.
      if (e.defaultPrevented) return;
      // A modal layered ABOVE the card owns the keyboard. Radix dialogs (the
      // ⌘K command palette, etc.) render in a body-level portal and mark the
      // rest of the tree `aria-hidden` while open; if the card now sits inside
      // an aria-hidden region, a higher overlay holds focus, so stay out of its
      // way — otherwise Enter/Escape driving that overlay would also resolve
      // the ask underneath it.
      if (cardRef.current?.closest('[aria-hidden="true"]')) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (interactionLocked) return;
        if (askAgentOpen) {
          setAskAgentOpen(false);
          setAskAgentLocalError(null);
          return;
        }
        onShowEarlierChat?.();
        return;
      }
      // Mobile soft keyboards have no Shift+Enter, so Enter must insert a
      // newline in the answer box; the Reply button is the only submit path.
      // Desktop keeps Enter-to-reply.
      if (e.key === "Enter" && !e.shiftKey && !mobile) {
        // An option row is a radio/checkbox button that owns Enter as its
        // toggle; let that native behavior stand rather than resolving.
        if (e.target instanceof HTMLElement && e.target.tagName === "BUTTON") return;
        // Ask agent mode hides the answer surface, but `canReply` still
        // reflects the HIDDEN draft — Enter must never resolve the request
        // with an answer the user cannot see while composing a
        // clarification. Enter is plain newline here; the footer button is
        // the only way to send the question.
        if (askAgentOpen) return;
        if (!canReply) return;
        e.preventDefault();
        reply();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [interactionLocked, canReply, onShowEarlierChat, reply, mobile, askAgentOpen]);

  // Visible chrome (border + fill + radius) lives on the WRAPPER, not the
  // textarea: the textarea is painted transparent so the mention overlay
  // behind it can draw the actual glyphs (PR 1256). An opaque textarea
  // background sits *above* that overlay and hides the typed text — the
  // white-on-white regression this restores. Mirrors chat-view's composer.
  // Radius lives in `.ask-answer-field` (index.css), not inline, so the phone
  // weld rule can flatten the top corners while the portal picker is docked.
  const fieldChrome = {
    position: "relative" as const,
    border: "var(--hairline) solid var(--border-strong)",
    background: "var(--bg)",
  };

  const ftStyle = {
    width: "100%",
    display: "block" as const,
    boxSizing: "border-box" as const,
    border: "none",
    background: "transparent",
    fontFamily: "inherit",
    lineHeight: 1.5,
    padding: "var(--sp-2_5) var(--sp-3)",
    resize: "vertical" as const,
    outline: "none",
  };

  // The mirror overlay MUST share the textarea's box metrics so painted chips
  // stay character-aligned with the (transparent) textarea glyphs.
  const mirrorStyle = {
    padding: "var(--sp-2_5) var(--sp-3)",
    lineHeight: 1.5,
    fontFamily: "inherit",
    // The textarea inherits the resting body size, but the mobile zoom guard
    // (index.css) raises form controls to the iOS no-zoom floor on phone
    // widths. The mirror is a <div>, so it isn't caught by that rule — read the
    // same var so its glyphs stay aligned with the textarea at both sizes.
    fontSize: "var(--composer-font-size)",
    boxSizing: "border-box" as const,
  };

  /** The shared free-text answer surface (used as "Other" beside options, or
   *  as the sole box on a free-text ask): mention autocomplete + highlight +
   *  image paste, with the text drawn by the mirror overlay. */
  const renderAnswerInput = (placeholder: string, minHeight: number) => (
    <div
      className="ask-answer-field"
      // Phone-only weld: flatten the field's top corners while the portal picker
      // is docked flush above it (`.ask-answer-field[data-picker-open]` in
      // index.css). composerPickerVisible keeps a trial `@` (no panel rendered)
      // from welding an empty field.
      data-picker-open={
        composerPickerVisible({ isTrial, mentionOpen: mention.trigger != null, slashOpen: false }) ? "true" : undefined
      }
      style={fieldChrome}
    >
      {/* No mention autocomplete on the trial answer input (single agent). */}
      {isTrial ? null : (
        <MentionAutocompletePopover
          trigger={mention.trigger}
          results={mention.results}
          highlightIndex={mention.highlightIndex}
          anchorRef={taRef}
          onPick={mention.pick}
          // Phone: portal the picker out of the answer card's scroll clip so its
          // first/active candidates stay visible. Wider viewports keep the
          // in-flow float (the card is tall enough there not to clip).
          portal={viewport === "narrow"}
          // Dismiss (not just hide) when the field scrolls out of the card so the
          // now-invisible picker can't be Enter-selected.
          onDismiss={mention.dismiss}
        />
      )}
      <MentionHighlightOverlay
        value={mentionComposer.displayText}
        participants={mentionParticipants}
        tokens={mentionComposer.tokens}
        textareaRef={taRef}
        chipClassName="mention-text"
        mirrorStyle={mirrorStyle}
      />
      <textarea
        ref={taRef}
        // Shares the composer's transparent-text overlay treatment: the class
        // carries `::selection` + `::placeholder { opacity: 1 }`, and the
        // utility colors the placeholder — without these the transparent text
        // color cascades to the placeholder and it renders invisible.
        className="mention-composer-textarea placeholder:text-muted-foreground"
        value={mentionComposer.displayText}
        disabled={interactionLocked}
        onChange={(e) => {
          // Token-model edit: adjusts mention tokens through the diff and
          // persists the canonical `@<name>` form into `freeText`.
          mentionComposer.handleInput(e.target.value);
          setCursor(e.target.selectionStart ?? e.target.value.length);
        }}
        onSelect={(e) => setCursor(e.currentTarget.selectionStart ?? mentionComposer.displayText.length)}
        onPaste={(e) => {
          // No attachments on the trial answer input — let text paste
          // fall through to the default handler.
          if (isTrial || interactionLocked) return;
          const files = Array.from(e.clipboardData.files);
          if (files.length > 0) {
            e.preventDefault();
            addFiles(files);
          }
        }}
        onKeyDown={(e) => {
          // Skip while an IME is composing so Enter confirms the candidate.
          if (e.nativeEvent.isComposing) return;
          // Atomic mention deletion: a collapsed caret flush against a
          // committed mention removes the whole token, not one character of
          // its display label.
          if (!isTrial && (e.key === "Backspace" || e.key === "Delete")) {
            const el = taRef.current;
            if (el && el.selectionStart === el.selectionEnd) {
              const removed = mentionComposer.deleteTokenAtCaret(
                el.selectionStart ?? cursor,
                e.key === "Backspace" ? "back" : "forward",
              );
              if (removed) {
                e.preventDefault();
                setCursor(removed.cursor);
                // Re-pin the DOM selection after commit — the native
                // deletion that would have moved it was preventDefaulted.
                requestAnimationFrame(() => {
                  const ta = taRef.current;
                  if (!ta) return;
                  ta.setSelectionRange(removed.cursor, removed.cursor);
                });
                return;
              }
            }
          }
          // Mention autocomplete gets first crack: when the caret is inside an
          // active `@trigger`, Enter/Tab/Arrows/Escape drive the popover (and
          // are preventDefaulted, so the window-level Enter→Reply / non-resolving
          // Escape backstop sees `defaultPrevented` and stays out of the way).
          // Disabled on trial (no mention), so Enter always resolves the ask.
          if (!isTrial) mention.handleKey(e);
        }}
        placeholder={placeholder}
        style={{
          ...ftStyle,
          minHeight,
          // Text is painted by the mirror overlay behind the textarea; keep
          // only the caret + selection visible here.
          color: "transparent",
          caretColor: "var(--fg)",
          // Promote above the overlay so the caret isn't hidden by it.
          position: "relative",
          zIndex: 1,
        }}
      />
    </div>
  );

  /** Staged attachments with a remove affordance — above the input. */
  const renderAttachmentTray = () =>
    pendingAttachments.length > 0 ? (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: "var(--sp-2)" }}>
        {pendingAttachments.map((att) =>
          att.kind === "image" && att.previewUrl ? (
            <div
              key={att.id}
              style={{
                position: "relative",
                flexShrink: 0,
                borderRadius: 4,
                border: "var(--hairline) solid var(--border)",
                overflow: "hidden",
              }}
            >
              <img
                src={att.previewUrl}
                alt={att.file.name}
                style={{ height: 44, width: "auto", display: "block", objectFit: "cover" }}
              />
              <button
                type="button"
                onClick={() => removeAttachment(att.id)}
                disabled={interactionLocked}
                aria-label="Remove image"
                style={{
                  position: "absolute",
                  top: 2,
                  right: 2,
                  // Mobile: a roomier corner × (kept modest vs the small thumbnail).
                  width: mobile ? 22 : 16,
                  height: mobile ? 22 : 16,
                  borderRadius: "50%",
                  background: "var(--color-overlay-scrim)",
                  border: "none",
                  color: "var(--bg-raised)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: interactionLocked ? "default" : "pointer",
                  opacity: interactionLocked ? 0.5 : 1,
                  padding: 0,
                }}
              >
                <X className={mobile ? "h-3 w-3" : "h-2.5 w-2.5"} />
              </button>
            </div>
          ) : (
            <FileChip
              key={att.id}
              filename={att.file.name}
              trailing={
                <button
                  type="button"
                  onClick={() => removeAttachment(att.id)}
                  disabled={interactionLocked}
                  aria-label={`Remove ${att.file.name}`}
                  style={{
                    // Mobile: a roomier tap target on the file chip's remove ×.
                    width: mobile ? 26 : 14,
                    height: mobile ? 26 : 14,
                    borderRadius: "50%",
                    background: "var(--color-overlay-scrim)",
                    border: "none",
                    color: "var(--bg-raised)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: interactionLocked ? "default" : "pointer",
                    opacity: interactionLocked ? 0.5 : 1,
                    padding: 0,
                  }}
                >
                  <X className={mobile ? "h-3.5 w-3.5" : "h-2 w-2"} />
                </button>
              }
            />
          ),
        )}
      </div>
    ) : null;

  /** The @ / attach icon row + hidden file input — below the input. */
  const renderInputToolbar = () =>
    // Trial: no @mention / attach toolbar — the answer input is just type + send.
    isTrial ? null : (
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)", marginTop: "var(--sp-2)" }}>
        <button
          type="button"
          onClick={insertMentionTrigger}
          disabled={interactionLocked}
          title="Mention an agent (or type @)"
          aria-label="Mention an agent"
          style={{
            background: "none",
            border: "none",
            cursor: interactionLocked ? "default" : "pointer",
            color: "var(--fg-3)",
            opacity: interactionLocked ? 0.5 : 1,
            padding: 0,
            display: "inline-flex",
            alignItems: "center",
            // Mobile: grow the tap target to the touch minimum (icon stays small).
            ...(mobile ? { width: 44, height: 44, justifyContent: "center" } : {}),
          }}
        >
          <AtSign className={mobile ? "h-5 w-5" : "h-3.5 w-3.5"} />
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={interactionLocked}
          title="Attach file"
          aria-label="Attach file"
          style={{
            background: "none",
            border: "none",
            cursor: interactionLocked ? "default" : "pointer",
            color: "var(--fg-3)",
            opacity: interactionLocked ? 0.5 : 1,
            padding: 0,
            display: "inline-flex",
            alignItems: "center",
            // Mobile: grow the tap target to the touch minimum (icon stays small).
            ...(mobile ? { width: 44, height: 44, justifyContent: "center" } : {}),
          }}
        >
          <Paperclip className={mobile ? "h-5 w-5" : "h-3.5 w-3.5"} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={COMPOSER_ACCEPT_ATTRIBUTE}
          multiple
          disabled={interactionLocked}
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files) {
              addFiles(Array.from(e.target.files));
              e.target.value = "";
            }
          }}
        />
      </div>
    );

  return (
    <div
      // Scrim over the workspace body; the ask is a centered card. The bottom
      // lifts above the on-screen keyboard so the card centers in the visible
      // area and its pinned footer stays reachable while the Other box is typed.
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: keyboardInset,
        zIndex: 30,
        display: "flex",
        alignItems: mobile ? "flex-end" : "center",
        justifyContent: "center",
        padding: mobile ? "var(--sp-2) 0 0" : "clamp(var(--sp-2_5), 2.5%, var(--sp-7))",
        background: "color-mix(in oklch, var(--fg) 10%, transparent)",
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-busy={interactionLocked || undefined}
        aria-label={askerName ? `Question from ${askerName}` : "Question awaiting your answer"}
        tabIndex={-1}
        style={{
          // Slightly wider than the message reading column; height fits the
          // content and is capped to the area (50rem cap).
          width: "min(100%, 50rem)",
          maxHeight: mobile ? "min(92%, 50rem)" : "100%",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          position: "relative",
          background: "var(--bg-raised)",
          border: "var(--hairline) solid var(--border)",
          borderRadius: mobile ? "var(--radius-dialog) var(--radius-dialog) 0 0" : "var(--radius-dialog)",
          boxShadow: "var(--shadow-md)",
        }}
      >
        {onShowEarlierChat ? (
          // A real header row, not an absolute overlay: the wide text button
          // would otherwise cover the question's first lines on narrow
          // widths. The row reserves its own space above the scroller.
          <div className="flex justify-end" style={{ flex: "0 0 auto", padding: "var(--sp-2) var(--sp-2) 0" }}>
            <button
              type="button"
              aria-label="Show earlier chat"
              title="Show earlier chat (Esc)"
              onClick={onShowEarlierChat}
              disabled={interactionLocked}
              className="inline-flex items-center text-label"
              style={{
                gap: "var(--sp-1_5)",
                // Mobile: 44 height clears the touch minimum.
                height: mobile ? 44 : 34,
                padding: "0 var(--sp-3)",
                border: 0,
                borderRadius: "var(--radius-input)",
                background: "var(--bg-raised)",
                color: "var(--fg-3)",
                cursor: interactionLocked ? "default" : "pointer",
                opacity: interactionLocked ? 0.5 : 1,
              }}
            >
              <History aria-hidden className="h-4 w-4" />
              Show earlier chat
            </button>
          </div>
        ) : null}
        {/* Scrolling region: the ask body PLUS the answer surface. Keeping the
            options inside the scroller (rather than in a fixed block) is what
            guarantees Reply is reachable — when the card is shorter than its
            content, this whole region clips and scrolls while the footer below
            stays pinned. The only scroller; the card itself never scrolls. */}
        <div
          ref={scrollRegionRef}
          style={{
            flex: "1 1 auto",
            minHeight: 0,
            overflowY: "auto",
          }}
        >
          {/* The ask — markdown body. */}
          <div
            className="text-body"
            style={{
              padding: `var(--sp-6) ${padX} var(--sp-5)`,
              color: "var(--fg-2)",
              lineHeight: 1.6,
            }}
          >
            <Markdown components={markdownComponents}>{body}</Markdown>
            <ImageRefGallery images={images} hasLeadingContent={body.trim().length > 0} />
            {contextDecision ? (
              <ContextDecisionReceipt receipt={contextDecision} gitlabInstanceOrigin={gitlabInstanceOrigin} />
            ) : null}
          </div>

          {askAgent && askAgent.exchanges.length > 0 ? (
            <section
              className="flex flex-col"
              style={{
                gap: "var(--sp-3)",
                padding: `0 ${padX} var(--sp-5)`,
              }}
              aria-label="Ask agent clarification"
            >
              {askAgent.exchanges.map((exchange) => (
                <div
                  key={exchange.clarification.id}
                  style={{
                    padding: "var(--sp-3)",
                    border: "var(--hairline) solid var(--border)",
                    borderRadius: "var(--radius-input)",
                    background: "var(--bg-sunken)",
                  }}
                >
                  <div className="text-label" style={{ color: "var(--fg-4)", marginBottom: "var(--sp-1)" }}>
                    You asked the agent
                  </div>
                  <Markdown>
                    {typeof exchange.clarification.content === "string" ? exchange.clarification.content : ""}
                  </Markdown>
                  {exchange.reply ? (
                    <div
                      style={{
                        marginTop: "var(--sp-3)",
                        paddingTop: "var(--sp-3)",
                        borderTop: "var(--hairline) solid var(--border-faint)",
                      }}
                    >
                      <div className="text-label" style={{ color: "var(--fg-4)", marginBottom: "var(--sp-1)" }}>
                        Agent response
                      </div>
                      <Markdown>
                        {typeof exchange.reply.content === "string"
                          ? exchange.reply.content
                          : JSON.stringify(exchange.reply.content)}
                      </Markdown>
                    </div>
                  ) : null}
                </div>
              ))}
              {askAgent.waiting ? (
                <div
                  role="status"
                  className="inline-flex items-center text-label"
                  style={{ gap: "var(--sp-2)", color: "var(--fg-3)" }}
                >
                  <span>Waiting for agent</span>
                  <span className="inline-flex" style={{ gap: 3 }} aria-hidden>
                    {[0, 1, 2].map((index) => (
                      <span
                        key={index}
                        className="animate-pulse"
                        style={{
                          width: 4,
                          height: 4,
                          borderRadius: "50%",
                          background: "currentColor",
                          animationDelay: `${index * 160}ms`,
                        }}
                      />
                    ))}
                  </span>
                </div>
              ) : null}
            </section>
          ) : null}

          {/* Answer surface — options + Other (or a single free-text box),
              both with `@mention` + attachments. Drop anywhere here to
              stage attachments, matching the composer. While Ask agent mode
              is active, this whole surface is REPLACED by the clarification
              composer — one input at a time, so the reply box and the
              question box never compete for the same footer actions. */}
          {askAgentOpen && askAgent ? (
            <div
              style={{
                padding: `var(--sp-4) ${padX} var(--sp-5)`,
                borderTop: "var(--hairline) solid var(--border-faint)",
              }}
            >
              <label className="text-label font-medium" htmlFor={`ask-agent-${requestId ?? "request"}`}>
                What would you like the agent to clarify?
              </label>
              <textarea
                ref={askAgentInputRef}
                id={`ask-agent-${requestId ?? "request"}`}
                value={askAgentDraft}
                disabled={interactionLocked}
                onChange={(event) => {
                  setAskAgentDraft(event.currentTarget.value);
                  setAskAgentLocalError(null);
                }}
                placeholder="Ask a focused question about the context above…"
                className="text-body"
                style={{
                  width: "100%",
                  minHeight: 88,
                  marginTop: "var(--sp-2)",
                  padding: "var(--sp-2_5) var(--sp-3)",
                  resize: "vertical",
                  border: "var(--hairline) solid var(--border-strong)",
                  borderRadius: "var(--radius-input)",
                  background: "var(--bg)",
                  color: "var(--fg)",
                  outline: "none",
                }}
              />
              {askAgentLocalError || askAgent.error ? (
                <p className="mono text-label" style={{ color: "var(--state-error)", margin: "var(--sp-2) 0 0" }}>
                  {askAgentLocalError ?? askAgent.error}
                </p>
              ) : null}
            </div>
          ) : (
            /* biome-ignore lint/a11y/noStaticElementInteractions: drop target for attachment upload (keyboard users use the attach button) */
            <div
              style={{
                padding: `var(--sp-4) ${padX} var(--sp-5)`,
                borderTop: "var(--hairline) solid var(--border-faint)",
              }}
              onDragOver={(e) => (isTrial ? undefined : e.preventDefault())}
              onDrop={(e) => {
                // No drag-and-drop attachments on the trial answer surface.
                if (isTrial || interactionLocked) return;
                e.preventDefault();
                addFiles(Array.from(e.dataTransfer.files));
              }}
            >
              {options ? (
                <>
                  <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
                    {options.map((opt) => (
                      <OptionRow
                        key={opt.label}
                        opt={opt}
                        multi={multi}
                        selected={selected.includes(opt.label)}
                        disabled={interactionLocked}
                        onToggle={() => toggle(opt.label)}
                      />
                    ))}
                  </div>
                  <div style={{ marginTop: "var(--sp-2)" }}>
                    {renderAttachmentTray()}
                    {renderAnswerInput("Other (type your own)…", 42)}
                    {renderInputToolbar()}
                  </div>
                </>
              ) : (
                <>
                  {renderAttachmentTray()}
                  {renderAnswerInput("Type your answer…", 110)}
                  {renderInputToolbar()}
                </>
              )}

              {(attachmentError || error) && (
                <p
                  className="mono text-label"
                  style={{ color: "var(--state-error)", padding: "var(--sp-2) var(--sp-0_5) 0" }}
                >
                  {attachmentError ?? error}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Pinned footer — Skip / Ask agent / Submit. */}
        <div
          data-ask-takeover-footer
          className={mobile ? "pb-safe-bottom" : undefined}
          style={{
            flex: "0 0 auto",
            borderTop: "var(--hairline) solid var(--border-faint)",
          }}
        >
          <div
            className="flex items-center justify-end"
            style={{
              gap: "var(--sp-3)",
              padding: `var(--sp-3) ${padX}`,
            }}
          >
            {askAgentOpen && askAgent ? (
              <>
                {/* Ask agent MODE: the same footer button that entered the
                    mode now SENDS the question — one affordance, two taps
                    (enter mode, then submit). Cancel returns to answering;
                    Skip/Submit hide so the resolving actions can't fire
                    against a half-written clarification. */}
                <button
                  type="button"
                  disabled={interactionLocked}
                  onClick={() => {
                    setAskAgentOpen(false);
                    setAskAgentLocalError(null);
                  }}
                  className="text-label"
                  style={{
                    height: mobile ? 44 : 34,
                    padding: "0 var(--sp-4)",
                    borderRadius: "var(--radius-input)",
                    border: "var(--hairline) solid transparent",
                    background: "transparent",
                    color: "var(--fg-2)",
                    cursor: interactionLocked ? "default" : "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={interactionLocked || askAgentDraft.trim().length === 0}
                  title="Send the clarification question"
                  onClick={() => {
                    const question = askAgentDraft.trim();
                    if (!question || interactionLocked) return;
                    setAskAgentLocalError(null);
                    void askAgent
                      .onAsk(question)
                      .then(() => {
                        setAskAgentDraft("");
                        setAskAgentOpen(false);
                      })
                      .catch((cause: unknown) => {
                        setAskAgentLocalError(cause instanceof Error ? cause.message : "Failed to ask the agent");
                      });
                  }}
                  className="text-label"
                  style={{
                    height: mobile ? 44 : 34,
                    padding: "0 var(--sp-4)",
                    borderRadius: "var(--radius-input)",
                    borderWidth: "var(--hairline)",
                    borderStyle: "solid",
                    borderColor: "var(--border-strong)",
                    background: "var(--bg-raised)",
                    color: "var(--fg)",
                    cursor: interactionLocked || askAgentDraft.trim().length === 0 ? "default" : "pointer",
                    opacity: interactionLocked || askAgentDraft.trim().length === 0 ? 0.5 : 1,
                  }}
                >
                  {askAgent.sending ? "Asking…" : "Ask agent"}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onSkip}
                  disabled={interactionLocked}
                  title="Skip"
                  className="text-label"
                  style={{
                    // Mobile: 44 height clears the touch minimum.
                    height: mobile ? 44 : 34,
                    padding: "0 var(--sp-4)",
                    borderRadius: "var(--radius-input)",
                    borderWidth: "var(--hairline)",
                    borderStyle: "solid",
                    borderColor: "transparent",
                    background: "transparent",
                    color: "var(--fg-2)",
                    cursor: interactionLocked ? "default" : "pointer",
                  }}
                >
                  Skip
                </button>
                {askAgent ? (
                  <button
                    type="button"
                    onClick={() => {
                      setAskAgentOpen(true);
                      setAskAgentLocalError(null);
                    }}
                    disabled={interactionLocked}
                    title="Ask the agent to clarify"
                    className="text-label"
                    style={{
                      height: mobile ? 44 : 34,
                      padding: "0 var(--sp-4)",
                      borderRadius: "var(--radius-input)",
                      borderWidth: "var(--hairline)",
                      borderStyle: "solid",
                      borderColor: "var(--border-strong)",
                      background: "transparent",
                      color: "var(--fg)",
                      cursor: interactionLocked ? "default" : "pointer",
                      opacity: interactionLocked ? 0.5 : 1,
                    }}
                  >
                    {askAgent.waiting ? "Waiting…" : "Ask agent"}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={reply}
                  disabled={!canReply}
                  title={mobile ? "Submit" : "Submit (Enter)"}
                  className="text-label"
                  style={{
                    // Mobile: 44 height clears the touch minimum (Reply is the only
                    // submit path there — Enter inserts a newline).
                    height: mobile ? 44 : 34,
                    padding: "0 var(--sp-4)",
                    borderRadius: "var(--radius-input)",
                    border: "var(--hairline) solid transparent",
                    background: "var(--primary)",
                    color: "var(--primary-on)",
                    cursor: canReply ? "pointer" : "default",
                    opacity: canReply ? 1 : 0.5,
                  }}
                >
                  {sending ? "Submitting…" : "Submit"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function OptionRow({
  opt,
  multi,
  selected,
  disabled,
  onToggle,
}: {
  opt: AskOption;
  multi: boolean;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the dynamic role is "radio" | "checkbox" — both support aria-checked.
    <button
      type="button"
      role={multi ? "checkbox" : "radio"}
      aria-checked={selected}
      disabled={disabled}
      onClick={onToggle}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "flex-start",
        gap: "var(--sp-3)",
        padding: "var(--sp-3)",
        textAlign: "left",
        border: `var(--hairline) solid ${selected ? "var(--border-strong)" : "var(--border)"}`,
        borderRadius: "var(--radius-panel)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
        background: selected ? "color-mix(in oklch, var(--fg) 8%, var(--bg-raised))" : "var(--bg)",
        fontWeight: selected ? 500 : 400,
        width: "100%",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 16,
          height: 16,
          flexShrink: 0,
          marginTop: 1,
          border: `var(--hairline-bold) solid ${selected ? "var(--fg)" : "var(--border-strong)"}`,
          borderRadius: multi ? "var(--radius-chip)" : "var(--radius-full)",
          background: selected ? "var(--fg)" : "transparent",
          display: "grid",
          placeItems: "center",
        }}
      >
        {selected ? (
          <span
            style={{
              width: multi ? 8 : 6,
              height: multi ? 8 : 6,
              borderRadius: multi ? 1 : "var(--radius-full)",
              background: "var(--bg-raised)",
            }}
          />
        ) : null}
      </span>
      <span style={{ minWidth: 0 }}>
        <span className="text-body" style={{ color: "var(--fg)", display: "block" }}>
          {opt.label}
        </span>
        <span className="text-body" style={{ color: "var(--fg-3)", display: "block", marginTop: 2 }}>
          {opt.description}
        </span>
        {selected && opt.preview ? (
          <span
            className="mono text-caption"
            style={{
              display: "block",
              marginTop: "var(--sp-2)",
              color: "var(--fg-2)",
              background: "var(--bg-sunken)",
              border: "var(--hairline) solid var(--border-faint)",
              borderRadius: "var(--radius-input)",
              padding: "var(--sp-2)",
              whiteSpace: "pre-wrap",
              // A long unbroken token (a command, a URL) must wrap instead of
              // overflowing the card horizontally on narrow widths.
              overflowWrap: "anywhere",
            }}
          >
            {opt.preview}
          </span>
        ) : null}
      </span>
    </button>
  );
}
