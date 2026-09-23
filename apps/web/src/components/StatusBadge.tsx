import { statusTone } from "../tokens.js";
import { Badge } from "./Badge.js";
import styles from "./StatusBadge.module.css";

/** W-01 StatusBadge: status label rendered verbatim, tone resolved through
 * the frozen statusTone map (unmapped → muted). */
export function StatusBadge({ label }: { readonly label: string }) {
  return (
    <span className={styles.badge}>
      <Badge tone={statusTone(label)}>{label}</Badge>
    </span>
  );
}
