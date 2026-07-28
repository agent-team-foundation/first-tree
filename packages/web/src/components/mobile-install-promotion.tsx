import { Check, Copy, Smartphone } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { type RefObject, useEffect, useState } from "react";
import { trackEvent } from "../analytics.js";
import { buildMobileInstallUrl, type MobileInstallSource, type MobilePromotionSource } from "../lib/mobile-install.js";
import { useCopyFeedback } from "../lib/use-copy-feedback.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog.js";

const QR_RENDER_SIZE = 256;

function mobileInstallUrl(source: MobileInstallSource): string {
  return buildMobileInstallUrl(typeof window === "undefined" ? "" : window.location.origin, source);
}

export function MobileInstallQr({ source, className }: { source: MobileInstallSource; className?: string }) {
  const installUrl = mobileInstallUrl(source);
  return (
    <span
      role="img"
      aria-label="QR code to install First Tree on a phone"
      className="inline-flex shrink-0 items-center justify-center"
      style={{
        padding: "var(--sp-2)",
        borderRadius: "var(--radius-panel)",
        background: "var(--qr-bg)",
      }}
    >
      <QRCodeSVG
        aria-hidden
        className={className}
        value={installUrl}
        size={QR_RENDER_SIZE}
        level="M"
        marginSize={2}
        fgColor="var(--qr-fg)"
        bgColor="var(--qr-bg)"
      />
    </span>
  );
}

export function OpenOnMobileDialog({
  open,
  onOpenChange,
  source,
  trigger,
  restoreFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: MobilePromotionSource;
  trigger?: React.ReactNode;
  restoreFocusRef?: RefObject<HTMLElement | null>;
}) {
  const installUrl = mobileInstallUrl(source);
  const copyFeedback = useCopyFeedback();

  useEffect(() => {
    if (!open) return;
    copyFeedback.reset();
    trackEvent("mobile_promo_opened", { source });
  }, [open, source, copyFeedback.reset]);

  const copyLabel =
    copyFeedback.status === "copied" ? "Copied" : copyFeedback.status === "failed" ? "Copy failed" : "Copy link";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent
        className="max-w-md"
        onCloseAutoFocus={(event) => {
          if (!restoreFocusRef?.current) return;
          event.preventDefault();
          restoreFocusRef.current.focus();
        }}
      >
        <DialogHeader className="items-center text-center sm:text-center">
          <span
            aria-hidden
            className="inline-flex items-center justify-center rounded-[var(--radius-full)]"
            style={{
              width: "var(--sp-10)",
              height: "var(--sp-10)",
              background: "var(--brand-bg)",
              color: "var(--brand)",
              marginBottom: "var(--sp-1)",
            }}
          >
            <Smartphone className="h-5 w-5" />
          </span>
          <DialogTitle>Open First Tree on your phone</DialogTitle>
          <DialogDescription>Scan to install. You’ll sign in once after installation.</DialogDescription>
        </DialogHeader>

        <div className="flex justify-center" style={{ padding: "var(--sp-2) 0" }}>
          <MobileInstallQr source={source} className="h-52 w-52" />
        </div>

        <div
          className="flex min-w-0 items-center"
          style={{
            gap: "var(--sp-2)",
            padding: "var(--sp-2)",
            borderRadius: "var(--radius-input)",
            background: "var(--bg-sunken)",
          }}
        >
          <span className="mono min-w-0 flex-1 truncate text-caption" style={{ color: "var(--fg-3)" }}>
            {installUrl}
          </span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => void copyFeedback.copy(installUrl)}
            aria-label={copyLabel}
          >
            {copyFeedback.status === "copied" ? (
              <Check aria-hidden className="h-3 w-3" />
            ) : (
              <Copy aria-hidden className="h-3 w-3" />
            )}
            {copyLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function MobileInstallCard() {
  const source = "start_chat";
  const [open, setOpen] = useState(false);

  return (
    <OpenOnMobileDialog
      open={open}
      onOpenChange={setOpen}
      source={source}
      trigger={
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          className="flex flex-col items-center rounded-[var(--radius-panel)] border border-border transition-colors hover:bg-accent/30 focus-visible:border-ring focus-visible:outline-none"
          style={{
            gap: "var(--sp-2)",
            padding: "var(--sp-3)",
            background: "transparent",
            color: "var(--fg)",
            cursor: "pointer",
          }}
        >
          <span className="text-label font-medium">Mobile app</span>
          <MobileInstallQr source={source} className="h-20 w-20" />
          <span className="text-caption" style={{ color: "var(--fg-4)" }}>
            Scan to install
          </span>
        </button>
      }
    />
  );
}
