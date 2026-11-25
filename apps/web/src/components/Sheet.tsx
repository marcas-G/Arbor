import { type ReactNode, useEffect, useRef } from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "./ui/dialog.js";

/** Controlled side/bottom panel for local product UI context. */
export function Sheet({
  open,
  title,
  onClose,
  mobileFullscreen = false,
  children,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly mobileFullscreen?: boolean | undefined;
  readonly children: ReactNode;
}) {
  const openerRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    return () => {
      openerRef.current?.focus();
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogPortal>
        <DialogOverlay className="fixed inset-0 z-[1000] bg-foreground/25" />
        <DialogContent
          aria-label={title}
          aria-describedby={undefined}
          className="fixed inset-y-0 right-0 z-[1001] h-full w-[min(28rem,100%)] overflow-y-auto border-0 border-l border-solid border-border bg-card shadow-float max-[40rem]:top-auto max-[40rem]:h-auto max-[40rem]:max-h-[75dvh] max-[40rem]:w-full max-[40rem]:rounded-t-md max-[40rem]:border-l-0 max-[40rem]:border-t max-[40rem]:data-[mobile-fullscreen=true]:top-0 max-[40rem]:data-[mobile-fullscreen=true]:h-full max-[40rem]:data-[mobile-fullscreen=true]:max-h-none max-[40rem]:data-[mobile-fullscreen=true]:rounded-none max-[40rem]:data-[mobile-fullscreen=true]:border-t-0"
          onOpenAutoFocus={(event) => {
            const active = document.activeElement;
            openerRef.current = active instanceof HTMLElement ? active : null;
            event.preventDefault();
            closeRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            openerRef.current?.focus();
          }}
          data-mobile-fullscreen={mobileFullscreen ? "true" : undefined}
        >
          <header className="flex items-center justify-between gap-3 border-0 border-b border-solid border-border px-5 py-3">
            <DialogTitle className="m-0 text-title text-foreground">
              {title}
            </DialogTitle>
            <DialogClose asChild>
              <button
                ref={closeRef}
                type="button"
                className="grid min-h-[var(--arbor-row-height)] min-w-[var(--arbor-row-height)] cursor-pointer place-items-center rounded-sm border-0 bg-transparent text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                aria-label="关闭"
              >
                ×
              </button>
            </DialogClose>
          </header>
          <div className="p-5">{children}</div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
