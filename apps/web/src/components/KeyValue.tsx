import type { ReactNode } from "react";
import styles from "./KeyValue.module.css";

export type KeyValuePair = {
  readonly label: string;
  readonly value: ReactNode;
};

/** W-01 KeyValue: definition-list block for identity/summary panels —
 * soft terms left, values right. */
export function KeyValue({
  pairs,
}: {
  readonly pairs: ReadonlyArray<KeyValuePair>;
}) {
  return (
    <dl className={styles.list}>
      {pairs.map((pair) => (
        <div key={pair.label} className={styles.pair}>
          <dt className={styles.term}>{pair.label}</dt>
          <dd className={styles.value}>{pair.value}</dd>
        </div>
      ))}
    </dl>
  );
}
