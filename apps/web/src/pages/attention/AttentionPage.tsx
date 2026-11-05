/**
 * Attention is a read-only monitoring surface. Rows select a frozen DTO for
 * inspection; the only available action navigates to its target workspace.
 */
import type { AttentionRow } from "@arbor/api-contracts";
import { useState } from "react";
import type { Route } from "../../api/router.js";
import { navigate } from "../../api/router.js";
import { problemFromUnknown } from "../../api/transport.js";
import { useViewQuery } from "../../api/useViewQuery.js";
import { Badge } from "../../components/Badge.js";
import { Button } from "../../components/Button.js";
import { Empty } from "../../components/Empty.js";
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

const severityLabel = (severity: string): string =>
  ({ ActionRequired: "需要处理", Attention: "需要留意" })[severity] ?? severity;

const sourceLabel = (source: string): string =>
  ({
    DependencyUnfulfillable: "依赖无法满足",
    Deadlock: "工作相互等待",
    RuntimeSafetyEnvelope: "运行安全限制",
    RecoveryEscalation: "恢复需要介入",
    AssignWorkTargetBindingFailure: "工作分配需要检查",
    VerifierOrphan: "验证结果待处理",
    VacantProducer: "缺少交付方",
  })[source] ?? source;

const readableSummary = (row: AttentionRow): string => {
  const summary = row.summaryRef;
  if (
    row.source === "DependencyUnfulfillable" &&
    /^dependency .+ marked unfulfillable \(revision \d+\)$/.test(summary)
  )
    return "一项工作所需的结果无法提供，请查看相关工作并调整安排。";
  if (
    row.source === "Deadlock" &&
    summary.startsWith("deadlock cycle ") &&
    summary.endsWith(
      " awaits governance (withdraw / mark-unfulfillable / steer)",
    )
  )
    return "多项工作正在相互等待，请查看依赖关系并调整安排。";
  if (
    row.source === "RuntimeSafetyEnvelope" &&
    /^execution .+ interrupted by runtime safety envelope \(RuntimeSafetyStop\)$/.test(
      summary,
    )
  )
    return "运行触及安全限制，已暂停。请查看相关工作。";
  if (
    row.source === "RecoveryEscalation" &&
    summary.startsWith("unreconcilable side effect: execution ")
  )
    return "上次操作的结果无法自动确认，需要人工检查后再继续。";
  if (
    row.source === "AssignWorkTargetBindingFailure" &&
    summary.startsWith(
      "A committed AssignWork could not be proven to match its exact target; recovery is paused.",
    )
  )
    return "无法确认工作分配的目标，恢复已暂停，请检查相关工作。";
  if (
    row.source === "VerifierOrphan" &&
    /^open verification .+ has no active verifier execution \(settle-without-conclude\)$/.test(
      summary,
    )
  )
    return "验证尚未得出结论，且当前没有验证任务在运行。";
  if (
    row.source === "VacantProducer" &&
    /^dependency .+ waits on vacant producer workspace .+ \(no Open Work, not retired\)$/.test(
      summary,
    )
  )
    return "一项工作正在等待交付，但交付方目前没有进行中的工作。";
  return summary;
};

const nextStep = (source: string): string =>
  ({
    DependencyUnfulfillable: "打开相关工作，检查依赖来源是否需要调整。",
    Deadlock: "打开相关工作，选择调整方向或结束其中一项等待。",
    RuntimeSafetyEnvelope: "打开相关工作，先查看运行记录；确认原因后再继续。",
    RecoveryEscalation: "打开相关工作，核对外部操作结果后再决定是否继续。",
    AssignWorkTargetBindingFailure:
      "检查项目分工权限和当前项目绑定，再重新安排工作。",
    VerifierOrphan: "打开相关工作，检查验证明细并重新触发后续流程。",
    VacantProducer: "检查交付方是否仍有开放工作，或重新安排依赖。",
  })[source] ?? "打开相关工作，查看最新运行记录和可用操作。";

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
    return <Empty>选择一条关注事项查看详情。</Empty>;
  }
  const summary = readableSummary(row);
  return (
    <div className={styles.inspection}>
      <div className={styles.inspectionHeading}>
        <div>
          <p className={styles.eyebrow}>事项详情</p>
          <h2>{sourceLabel(row.source)}</h2>
        </div>
        <StatusBadge label={severityLabel(row.severity)} />
      </div>
      <dl className={styles.inspectionFields}>
        <div>
          <dt>问题来源</dt>
          <dd>
            <StatusBadge label={sourceLabel(row.source)} />
          </dd>
        </div>
        <div>
          <dt>处理优先级</dt>
          <dd>
            <StatusBadge label={severityLabel(row.severity)} />
          </dd>
        </div>
        <div>
          <dt>简要说明</dt>
          <dd>
            <span>{summary}</span>
          </dd>
        </div>
        <div>
          <dt>发生时间</dt>
          <dd>
            <TimeText at={row.occurredAt} />
          </dd>
        </div>
        <div>
          <dt>相关分工</dt>
          <dd>
            <span>打开后查看具体工作</span>
          </dd>
        </div>
        <div>
          <dt>状态</dt>
          <dd>
            <span>同类事项会自动合并</span>
          </dd>
        </div>
        <div>
          <dt>建议下一步</dt>
          <dd>
            <span>{nextStep(row.source)}</span>
          </dd>
        </div>
      </dl>
      {summary === row.summaryRef ? null : (
        <details>
          <summary>技术详情</summary>
          <code>{row.summaryRef}</code>
        </details>
      )}
      <p className={styles.readOnlyNote}>
        关注事项仅供检查；查看相关分工不会更改此事项。
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
        查看相关工作
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
          <p className={styles.eyebrow}>项目提醒</p>
          <h1 className={styles.title}>关注事项</h1>
        </div>
        <span className={styles.caption}>待处理提醒 · 只读</span>
      </header>
      {query.isPending ? (
        <Empty>正在加载关注事项</Empty>
      ) : query.isError && query.data === undefined ? (
        <ProblemCard
          problem={problemFromUnknown(query.error)}
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : (
        <>
          {query.isError ? (
            <div className={styles.staleProblem}>
              <p role="status">刷新失败，以下内容来自上次成功读取。</p>
              <ProblemCard problem={problemFromUnknown(query.error)} />
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
                    <Badge tone={statusTone(source)}>
                      {sourceLabel(source)}
                    </Badge>
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
                          <Badge tone={statusTone(severity)}>
                            {severityLabel(severity)}
                          </Badge>
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
                                  <StatusBadge
                                    label={sourceLabel(row.source)}
                                  />
                                  <StatusBadge
                                    label={severityLabel(row.severity)}
                                  />
                                </span>
                                <span>{readableSummary(row)}</span>
                                <TimeText at={row.occurredAt} />
                                <span className={styles.targetPreview}>
                                  相关分工
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
