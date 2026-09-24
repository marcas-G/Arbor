import { type ReactNode, useRef } from "react";
import styles from "./Sheet.module.css";
import { useModalFocus } from "./useModalFocus.js";

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
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  useModalFocus({
    open,
    onClose,
    containerRef: sheetRef,
    initialFocusRef: closeRef,
  });

  if (!open) {
    return null;
  }
  return (
    <div className={styles.overlay}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={sheetRef}
        tabIndex={-1}
        className={styles.sheet}
        data-mobile-fullscreen={mobileFullscreen ? "true" : undefined}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          <button
            ref={closeRef}
            type="button"
            className={styles.close}
            aria-label="关闭"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className={styles.body}>{children}</div>
      </section>
    </div>
  );
}
