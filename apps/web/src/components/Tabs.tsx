import { cx } from "./cx.js";
import styles from "./Tabs.module.css";

export type TabItem = {
  readonly key: string;
  readonly label: string;
};

/** W-01 Tabs: hairline tab strip; selection is owned by the caller
 * (active + onChange), items render as role=tab buttons. */
export function Tabs({
  items,
  active,
  onChange,
}: {
  readonly items: ReadonlyArray<TabItem>;
  readonly active: string;
  readonly onChange: (key: string) => void;
}) {
  return (
    <div className={styles.tabs} role="tablist">
      {items.map((item) => {
        const selected = item.key === active;
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={selected}
            className={cx([
              styles.tab,
              selected ? styles.tabActive : undefined,
            ])}
            onClick={() => {
              onChange(item.key);
            }}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
