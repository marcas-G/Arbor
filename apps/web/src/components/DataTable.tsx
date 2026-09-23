import type { ReactNode } from "react";
import styles from "./DataTable.module.css";
import { Empty } from "./Empty.js";

export type DataTableColumn = {
  readonly key: string;
  readonly label: string;
  readonly align?: "left" | "right" | "center" | undefined;
};

export type DataTableRow = Record<string, ReactNode>;

const ALIGN_CLASS = {
  left: "alignLeft",
  right: "alignRight",
  center: "alignCenter",
} as const;

/** W-01 DataTable: compact botanical paper table (mono headers, 34px rows
 * via --arbor-row-height). Empty rows fall through to the internal Empty. */
export function DataTable({
  columns,
  rows,
  rowKey,
}: {
  readonly columns: ReadonlyArray<DataTableColumn>;
  readonly rows: ReadonlyArray<DataTableRow>;
  readonly rowKey: (row: DataTableRow) => string;
}) {
  if (rows.length === 0) {
    return <Empty>暂无数据</Empty>;
  }
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          {columns.map((column) => {
            const align = column.align ?? "left";
            return (
              <th
                key={column.key}
                scope="col"
                className={styles[ALIGN_CLASS[align]]}
              >
                {column.label}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)} className={styles.row}>
            {columns.map((column) => {
              const align = column.align ?? "left";
              return (
                <td key={column.key} className={styles[ALIGN_CLASS[align]]}>
                  {row[column.key] ?? null}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
