import type { Tone } from "../tokens.js";
import { cx } from "./cx.js";
import styles from "./Toaster.module.css";

export type Toast = {
  readonly id: string;
  readonly tone: Tone;
  readonly text: string;
};

/** W-01 Toaster: fixed top-right transient notifications; dismissal is
 * owned by the caller (onDismiss receives the toast id). */
export function Toaster({
  toasts,
  onDismiss,
}: {
  readonly toasts: ReadonlyArray<Toast>;
  readonly onDismiss: (id: string) => void;
}) {
  return (
    <section className={styles.toaster} aria-label="通知">
      <ul className={styles.list}>
        {toasts.map((toast) => (
          <li
            key={toast.id}
            role="status"
            className={cx([styles.toast, styles[`tone-${toast.tone}`]])}
          >
            <span className={styles.text}>{toast.text}</span>
            <button
              type="button"
              className={styles.dismiss}
              aria-label="关闭"
              onClick={() => {
                onDismiss(toast.id);
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
