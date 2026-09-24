/**
 * Attention is a read-only monitoring surface. Rows select a frozen DTO for
 * inspection; the only available action navigates to its target workspace.
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
import { Sheet } from "../../components/Sheet.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { useCompactLayout } from "../../components/useCompactLayout.js";
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

const rowId = (row: AttentionRow): string => `${row.source}:${row.dedupKey}`;

/** Severity groups retain server order within each known or unknown group. */
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

function AttentionInspection({
  row,
  projectId,
}: {
  readonly row: AttentionRow | null;
  readonly projectId: string;
}) {
  if (row === null) {
    return <Empty>选择一条关注事项查看冻结的诊断信息。</Empty>;
  }
  return (
    <div className={styles.inspection}>
      <div className={styles.inspectionHeading}>
        <div>
          <p className={styles.eyebrow}>Read-only inspection</p>
          <h2>{row.summaryRef}</h2>
        </div>
        <StatusBadge label={row.severity} />
      </div>
      <dl className={styles.inspectionFields}>
        <div>
          <dt>Source</dt>
          <dd>
            <StatusBadge label={row.source} />
          </dd>
        </div>
        <div>
          <dt>Severity</dt>
          <dd>
            <StatusBadge label={row.severity} />
          </dd>
        </div>
        <div>
          <dt>Summary reference</dt>
          <dd>
            <MonoText>{row.summaryRef}</MonoText>
          </dd>
        </div>
        <div>
          <dt>Occurred at</dt>
          <dd>
            <TimeText at={row.occurredAt} />
          </dd>
        </div>
        <div>
          <dt>Target workspace</dt>
          <dd>
            <MonoText>{row.targetWorkspaceId}</MonoText>
          </dd>
        </div>
        <div>
          <dt>Deduplication key</dt>
          <dd>
            <MonoText>{row.dedupKey}</MonoText>
          </dd>
        </div>
      </dl>
      <p className={styles.readOnlyNote}>
        关注事项仅供检查；打开目标工作区不会更改此事项。
      </p>
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
        打开目标工作区
      </Button>
    </div>
  );
}

export function AttentionPage({
  route,
}: {
  readonly route: Extract<Route, { name: "attention" }>;
}) {
  const compact = useCompactLayout();
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
  const selected =
    filtered.find((row) => rowId(row) === selectedId) ?? filtered[0] ?? null;
  const mobileSheetOpen =
    compact &&
    selectedId !== null &&
    selected !== null &&
    rowId(selected) === selectedId;

  const selectSource = (source: string | null): void => {
    setSourceFilter(source);
    setSelectedId(null);
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Read-only monitoring</p>
          <h1 className={styles.title}>关注事项</h1>
        </div>
        <span className={styles.caption}>诊断面 · 只读</span>
      </header>
      {query.isPending ? (
        <Empty>正在加载关注事项</Empty>
      ) : query.isError && query.data === undefined ? (
        <ProblemCard
          problem={query.error as unknown as Problem}
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : (
        <>
          {query.isError ? (
            <div className={styles.staleProblem}>
              <p role="status">刷新失败，以下内容来自上次成功读取。</p>
              <ProblemCard problem={query.error as unknown as Problem} />
            </div>
          ) : query.isRefetching ? (
            <p className={styles.refreshing} role="status">
              正在刷新关注事项
            </p>
          ) : null}
          {rows.length === 0 ? (
            <Empty>无关注事项</Empty>
          ) : (
            <>
              <fieldset className={styles.filterBar}>
                <legend className={styles.filterLegend}>按来源筛选</legend>
                <button
                  type="button"
                  className={styles.chip}
                  aria-pressed={sourceFilter === null}
                  onClick={() => selectSource(null)}
                >
                  全部
                </button>
                {options.map((source) => (
                  <button
                    key={source}
                    type="button"
                    className={styles.chip}
                    aria-pressed={sourceFilter === source}
                    onClick={() => selectSource(source)}
                  >
                    <Badge tone={statusTone(source)}>{source}</Badge>
                  </button>
                ))}
              </fieldset>
              {groups.length === 0 ? (
                <Empty>无匹配关注事项</Empty>
              ) : (
                <div className={styles.inspectionLayout}>
                  <section className={styles.groups} aria-label="关注事项分组">
                    {groups.map(([severity, severityRows]) => (
                      <section key={severity} className={styles.group}>
                        <h2 className={styles.groupTitle}>
                          <Badge tone={statusTone(severity)}>{severity}</Badge>
                          <span
                            className={styles.groupCount}
                          >{`${String(severityRows.length)} 条`}</span>
                        </h2>
                        <ul className={styles.rowList}>
                          {severityRows.map((row) => (
                            <li key={rowId(row)}>
                              <button
                                type="button"
                                className={styles.rowButton}
                                aria-pressed={rowId(row) === selectedId}
                                onClick={() => setSelectedId(rowId(row))}
                              >
                                <span className={styles.rowMeta}>
                                  <StatusBadge label={row.source} />
                                  <StatusBadge label={row.severity} />
                                </span>
                                <MonoText>{row.summaryRef}</MonoText>
                                <TimeText at={row.occurredAt} />
                                <span className={styles.targetPreview}>
                                  目标工作区{" "}
                                  <MonoText>{row.targetWorkspaceId}</MonoText>
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </section>
                    ))}
                  </section>
                  {!compact ? (
                    <aside
                      className={styles.inspectionPanel}
                      aria-label="关注事项检查面板"
                    >
                      <AttentionInspection
                        row={selected}
                        projectId={route.projectId}
                      />
                    </aside>
                  ) : null}
                  <Sheet
                    open={mobileSheetOpen}
                    title="关注事项检查"
                    onClose={() => setSelectedId(null)}
                  >
                    <AttentionInspection
                      row={selected}
                      projectId={route.projectId}
                    />
                  </Sheet>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
