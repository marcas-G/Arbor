import styles from "./TimeText.module.css";

/** W-01 TimeText: ISO timestamp → localized text; the raw value stays
 * inspectable via the title attribute (and <time datetime>). */
export function TimeText({ iso }: { readonly iso: string }) {
  const parsed = new Date(iso);
  const text = Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
  return (
    <time className={styles.time} dateTime={iso} title={iso}>
      {text}
    </time>
  );
}
