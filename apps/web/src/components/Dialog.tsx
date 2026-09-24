import { type ReactNode, useRef } from "react";
import styles from "./Dialog.module.css";
import { useModalFocus } from "./useModalFocus.js";

/** W-01 Dialog: surface-tinted overlay; desktop centered card, mobile
 * full-screen sheet (CSS). Keyboard focus stays contained and returns to the
 * opener when the controlled surface closes. */
export function Dialog({
  open,
  title,
  onClose,
  children,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useModalFocus({
    open,
    onClose,
    containerRef: dialogRef,
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
        ref={dialogRef}
        tabIndex={-1}
        className={styles.dialog}
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
