/**
 * W-06 — Attention 关注事项页（frozen §2.6，read-only 诊断面）：
 * severity 分组（ActionRequired 组在前，组头 danger/attention Badge +
 * 计数）+ source 单选筛选（六源 + 全部；未知 source 原样呈现 option，
 * muted 不丢弃）+ 行（source StatusBadge / summaryRef Mono / occurredAt /
 * 目标工作区导航）。本页是 dedupKey 的唯一权威列表源；0 个 command、
 * 0 个变更动作。
 */
import type { AttentionRow, Problem } from "@arbor/api-contracts";
import { useState } from "react";
import type { Route } from "../../api/router.js";
import { navigate } from "../../api/router.js";
import { useViewQuery } from "../../api/useViewQuery.js";
import { Badge } from "../../components/Badge.js";
import { Button } from "../../components/Button.js";
import { Empty } from "../../components/Empty.js";
import { MonoText } from "../../components/MonoText.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { ProblemCard } from "../../problems/ProblemCard.js";
import { statusTone } from "../../tokens.js";
import { TimeText } from "../../views/shared.js";
import styles from "./attention.module.css";

const SEVERITY_ORDER: ReadonlyArray<string> = ["ActionRequired", "Attention"];

const SIX_SOURCES: ReadonlyArray<string> = [
  "DependencyUnfulfillable",
  "Deadlock",
  "RuntimeSafetyEnvelope",
  "RecoveryEscalation",
  "VerifierOrphan",
  "VacantProducer",
];

/** severity 分组：已知序（ActionRequired 在前）+ 未知 severity 按首现追加。 */
function groupRows(
  rows: ReadonlyArray<AttentionRow>,
): ReadonlyArray<[string, ReadonlyArray<AttentionRow>]> {
  const groups = new Map<string, AttentionRow[]>();
  for (const row of rows) {
    const bucket = groups.get(row.severity);
    if (bucket === undefined) {
      groups.set(row.severity, [row]);
    } else {
      bucket.push(row);
    }
  }
  const known = SEVERITY_ORDER.filter((severity) => groups.has(severity));
  const unknown = [...groups.keys()].filter(
    (severity) => !SEVERITY_ORDER.includes(severity),
  );
  return [...known, ...unknown].map(
    (severity) => [severity, groups.get(severity) ?? []] as const,
  );
}

function AttentionRowItem({
  row,
  projectId,
}: {
  readonly row: AttentionRow;
  readonly projectId: string;
}) {
  return (
    <li className={styles.row}>
      <StatusBadge label={row.source} />
      <MonoText>{row.summaryRef}</MonoText>
      <TimeText at={row.occurredAt} />
      <Button
        variant="quiet"
        onClick={() => {
          navigate({
            name: "workspace",
            projectId,
            workspaceId: row.targetWorkspaceId,
            tab: "overview",
          });
        }}
      >
        <MonoText>{row.targetWorkspaceId}</MonoText>
      </Button>
    </li>
  );
}

export function AttentionPage({
  route,
}: {
  readonly route: Extract<Route, { name: "attention" }>;
}) {
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const query = useViewQuery("attention", {
    projectId: route.projectId as never,
  });
  const rows = query.data?.rows ?? [];
  const unknownSources = [
    ...new Set(
      rows
        .map((row) => row.source)
        .filter((source) => !SIX_SOURCES.includes(source)),
    ),
  ];
  const options = [...SIX_SOURCES, ...unknownSources];
  const filtered =
    sourceFilter === null
      ? rows
      : rows.filter((row) => row.source === sourceFilter);
  const groups = groupRows(filtered);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>关注事项</h1>
        <span className={styles.caption}>诊断面 · 只读</span>
      </header>
      {query.isPending ? (
        <Empty>加载中</Empty>
      ) : query.isError ? (
        <ProblemCard problem={query.error as unknown as Problem} />
      ) : rows.length === 0 ? (
        <Empty>无关注事项</Empty>
      ) : (
        <>
          <fieldset className={styles.filterBar}>
            <legend className={styles.filterLegend}>source 筛选</legend>
            <button
              type="button"
              className={styles.chip}
              aria-pressed={sourceFilter === null}
              onClick={() => {
                setSourceFilter(null);
              }}
            >
              全部
            </button>
            {options.map((source) => (
              <button
                key={source}
                type="button"
                className={styles.chip}
                aria-pressed={sourceFilter === source}
                onClick={() => {
                  setSourceFilter(source);
                }}
              >
                <Badge tone={statusTone(source)}>{source}</Badge>
              </button>
            ))}
          </fieldset>
          {groups.length === 0 ? (
            <Empty>无关注事项</Empty>
          ) : (
            <div className={styles.groups}>
              {groups.map(([severity, severityRows]) => (
                <section key={severity} className={styles.group}>
                  <h3 className={styles.groupTitle}>
                    <Badge tone={statusTone(severity)}>{severity}</Badge>
                    <span
                      className={styles.groupCount}
                    >{`${String(severityRows.length)} 条`}</span>
                  </h3>
                  <ul className={styles.rowList}>
                    {severityRows.map((row) => (
                      <AttentionRowItem
                        key={`${row.source}:${row.dedupKey}`}
                        row={row}
                        projectId={route.projectId}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
