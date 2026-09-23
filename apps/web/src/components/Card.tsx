import type { ReactNode } from "react";
import styles from "./Card.module.css";
import { cx } from "./cx.js";

/** W-01 formal Card: optional `title` on the left, optional `actions` on
 * the right of the header row. */
export function Card({
  title,
  actions,
  children,
}: {
  readonly title?: string | undefined;
  readonly actions?: ReactNode | undefined;
  readonly children: ReactNode;
}) {
  const hasHeader = title !== undefined || actions !== undefined;
  return (
    <section className={cx(["arbor-card", styles.card])}>
      {hasHeader ? (
        <header className={cx(["arbor-card-header", styles.header])}>
          {title === undefined ? null : (
            <h2 className={cx(["arbor-card-title", styles.title])}>{title}</h2>
          )}
          {actions === undefined ? null : (
            <div className={styles.actions}>{actions}</div>
          )}
        </header>
      ) : null}
      <div className={cx(["arbor-card-body", styles.body])}>{children}</div>
    </section>
  );
}
