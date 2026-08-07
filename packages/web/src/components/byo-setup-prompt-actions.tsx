import { Check, Clipboard, Eye, LockKeyhole } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useCopyFeedback } from "../lib/use-copy-feedback.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.js";
import { Textarea } from "./ui/textarea.js";

type ByoSetupPromptActionsProps = {
  align?: "start" | "end";
  preparePrompt: () => Promise<string>;
  resetKey: string;
};

export function ByoSetupPromptActions({ align = "start", preparePrompt, resetKey }: ByoSetupPromptActionsProps) {
  const copyFeedback = useCopyFeedback();
  const [preparing, setPreparing] = useState(false);
  const [prepareFailed, setPrepareFailed] = useState(false);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [copyingPrompt, setCopyingPrompt] = useState(false);
  const prepareAttempt = useRef(0);
  const copyAttempt = useRef(0);
  const activeResetKey = useRef(resetKey);
  const preparePromptRef = useRef(preparePrompt);
  activeResetKey.current = resetKey;
  preparePromptRef.current = preparePrompt;

  useEffect(() => {
    const renderedResetKey = resetKey;
    prepareAttempt.current += 1;
    copyAttempt.current += 1;
    setPreparing(false);
    setPrepareFailed(false);
    setPrompt(null);
    setOpen(false);
    setCopyingPrompt(false);
    copyFeedback.reset();
    return () => {
      if (activeResetKey.current === renderedResetKey) {
        prepareAttempt.current += 1;
        copyAttempt.current += 1;
      }
    };
  }, [copyFeedback.reset, resetKey]);

  const closePrompt = (): void => {
    copyAttempt.current += 1;
    setOpen(false);
    setPrompt(null);
    setCopyingPrompt(false);
    copyFeedback.reset();
  };

  const prepare = (): void => {
    const attempt = ++prepareAttempt.current;
    const renderedResetKey = resetKey;
    setPreparing(true);
    setPrepareFailed(false);
    copyFeedback.reset();
    void (async () => {
      try {
        const nextPrompt = await preparePromptRef.current();
        if (prepareAttempt.current !== attempt || activeResetKey.current !== renderedResetKey) return;
        setPreparing(false);
        setPrompt(nextPrompt);
        setOpen(true);
      } catch {
        if (prepareAttempt.current !== attempt || activeResetKey.current !== renderedResetKey) return;
        setPreparing(false);
        setPrepareFailed(true);
      }
    })();
  };

  const copyPrompt = (): void => {
    if (!prompt) return;
    const copy = ++copyAttempt.current;
    const renderedPrompt = prompt;
    const renderedResetKey = resetKey;
    setCopyingPrompt(true);
    void (async () => {
      await copyFeedback.copy(renderedPrompt);
      if (copyAttempt.current !== copy || activeResetKey.current !== renderedResetKey) return;
      setCopyingPrompt(false);
    })();
  };

  return (
    <div
      data-byo-prompt-actions
      className={`flex flex-col ${align === "end" ? "items-end" : "items-start"}`}
      style={{ gap: "var(--sp-2)" }}
    >
      <div
        className={`flex flex-wrap items-center ${align === "end" ? "justify-end" : "justify-start"}`}
        style={{ gap: "var(--sp-1)" }}
      >
        <Button type="button" size="sm" disabled={preparing} onClick={prepare}>
          <Eye className="h-3.5 w-3.5" aria-hidden />
          {preparing ? "Preparing…" : "View setup prompt"}
        </Button>
      </div>

      {prepareFailed ? (
        <p role="alert" className="text-label" style={{ margin: 0, color: "var(--state-error)" }}>
          Could not prepare the setup prompt.
        </p>
      ) : copyFeedback.status === "failed" ? (
        <p role="alert" className="text-label" style={{ margin: 0, color: "var(--state-error)" }}>
          Could not copy the setup prompt.
        </p>
      ) : null}

      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closePrompt();
        }}
      >
        <DialogContent data-clarity-mask="true" className="max-h-[calc(100vh-var(--sp-8))] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Setup prompt</DialogTitle>
            <DialogDescription style={{ color: "var(--fg-2)" }}>
              Copy this into Claude Code or Codex. The coding agent will handle technical steps and ask only when
              needed.
            </DialogDescription>
          </DialogHeader>

          <Textarea
            data-byo-setup-prompt-preview
            aria-label="Setup prompt"
            readOnly
            spellCheck={false}
            value={prompt ?? ""}
            className="h-80 min-h-24 w-full max-h-[40vh] resize-none rounded-[var(--radius-panel)] border border-border bg-bg-sunken p-4 font-mono text-label text-foreground"
          />

          {copyFeedback.status === "failed" ? (
            <p role="alert" className="text-label" style={{ margin: 0, color: "var(--state-error)" }}>
              Could not copy the setup prompt.
            </p>
          ) : null}

          <div className="flex items-center" style={{ gap: "var(--sp-2)", color: "var(--fg-3)" }}>
            <LockKeyhole className="h-4 w-4 shrink-0" aria-hidden />
            <p className="text-label" style={{ margin: 0 }}>
              Contains a temporary sign-in code. Don&apos;t share it.
            </p>
          </div>

          <DialogFooter>
            <span aria-live="polite" className="sr-only">
              {copyFeedback.status === "copied" ? "Setup prompt copied." : ""}
            </span>
            <Button type="button" variant="ghost" onClick={closePrompt}>
              Close
            </Button>
            <Button
              type="button"
              aria-label={!copyingPrompt && copyFeedback.status === "copied" ? "Copied. Copy prompt again" : undefined}
              disabled={copyingPrompt}
              onClick={copyPrompt}
            >
              {!copyingPrompt && copyFeedback.status === "copied" ? (
                <Check className="h-4 w-4" aria-hidden />
              ) : (
                <Clipboard className="h-4 w-4" aria-hidden />
              )}
              {copyingPrompt ? "Copying…" : copyFeedback.status === "copied" ? "Copied" : "Copy prompt"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
