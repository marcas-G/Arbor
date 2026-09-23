import { type ReactNode, useEffect, useRef } from "react";
import styles from "./Dialog.module.css";

/** W-01 Dialog: surface-tinted overlay; desktop centered card, mobile
 * full-screen sheet (CSS). Esc closes; simplified focus handling moves
 * initial focus to the close button. */
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

  useEffect(() => {
    if (!open) {
      return;
    }
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }
  return (
    <div className={styles.overlay}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
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
