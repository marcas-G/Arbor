/**
 * workspace-detail view: full panoramic card group. Pending-work rows are
 * plain lists (NOT selection controls, `02` §4); ID cross-links land with
 * routing in a later task — this layer renders IDs verbatim in mono.
 */
import type { WorkspaceDetailRes } from "@arbor/api-contracts";
import { Card } from "../components/Card.js";
import { Empty } from "../components/Empty.js";
import { cn } from "../lib/utils.js";
import { DependencyTable } from "./DependencyView.js";
import { InboxRows } from "./InboxView.js";
import { EnumBadge, Mono, SandboxPolicySummary, TimeText } from "./shared.js";
import { VerificationView } from "./VerificationView.js";

type Address = WorkspaceDetailRes["boundary"]["addresses"][number];

function addressText(address: Address): string {
  switch (address._tag) {
    case "FileTree":
      return `FileTree ${address.path}`;
    case "GitWorktree":
      return `GitWorktree ${address.path}${
        address.branch === undefined ? "" : ` @${address.branch}`
      }`;
    case "DatabaseNamespace":
      return `DatabaseNamespace ${address.namespace}`;
    case "ExternalResource":
      return `ExternalResource ${address.address}`;
    default:
      return JSON.stringify(address) ?? "unknown-address";
  }
}

function StringList({
  label,
  values,
}: {
  readonly label: string;
  readonly values: ReadonlyArray<string>;
}) {
  if (values.length === 0) {
    return null;
  }
  return (
    <div className={cn("arbor-kv", "flex flex-col gap-ui-1")}>
      <span
        className={cn(
          "arbor-kv-label",
          "text-muted-foreground font-sans text-caption",
        )}
      >
        {label}
      </span>
      <ul
        className={cn(
          "arbor-row-list",
          "flex flex-col gap-ui-2 m-0 p-0 list-none",
        )}
      >
        {values.map((value) => (
          <li key={value}>{value}</li>
        ))}
      </ul>
    </div>
  );
}

export function WorkspaceDetailView({
  res,
}: {
  readonly res: WorkspaceDetailRes;
}) {
  const r = res.responsibility;
  return (
    <div className={cn("arbor-view-stack", "flex flex-col gap-ui-3")}>
      <Card title="Responsibility">
        <div className={cn("arbor-view-stack", "flex flex-col gap-ui-3")}>
          <span>{r.purpose}</span>
          <StringList
            label="ownedResponsibilities"
            values={r.ownedResponsibilities}
          />
          <StringList label="obligations" values={r.obligations} />
          <StringList label="includes" values={r.includes} />
          <StringList label="excludes" values={r.excludes} />
          <StringList label="interfaces" values={r.interfaces} />
        </div>
      </Card>
      <Card title="Resource Boundary">
        <div className={cn("arbor-view-stack", "flex flex-col gap-ui-3")}>
          <div className={cn("arbor-kv", "flex flex-col gap-ui-1")}>
            <span
              className={cn(
                "arbor-kv-label",
                "text-muted-foreground font-sans text-caption",
              )}
            >
              basisResponsibilityRevision
            </span>
            <Mono>{String(res.boundary.basisResponsibilityRevision)}</Mono>
          </div>
          {res.boundary.addresses.length === 0 ? (
            <Empty>无资源地址</Empty>
          ) : (
            <ul
              className={cn(
                "arbor-row-list",
                "flex flex-col gap-ui-2 m-0 p-0 list-none",
              )}
            >
              {res.boundary.addresses.map((address, index) => (
                <li key={`${address._tag}:${String(index)}`}>
                  <Mono>{addressText(address)}</Mono>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
      {res.sandboxPolicyCandidateRead === undefined ? null : (
        <Card title="沙箱策略候选（需人工选择）">
          <ul
            className={cn(
              "arbor-row-list",
              "flex flex-col gap-ui-2 m-0 p-0 list-none",
            )}
          >
            {res.sandboxPolicyCandidateRead.candidates.map((candidate) => (
              <li key={candidate.candidateId}>
                {candidate.kind === "TrustedLocalUnconfinedV1"
                  ? "TrustedLocal · FullAccess · 不受 OS 隔离（高风险）"
                  : `${candidate.providerId} ${candidate.providerVersion} · capability ${candidate.capabilityRevision} · ${candidate.profile === "ReadOnly" ? "只读" : "工作区写入"} · ${candidate.networkMode}`}
              </li>
            ))}
          </ul>
          <p>选择需要在命令提交时单独确认；本列表不会自动选择或提交。</p>
        </Card>
      )}
      {res.currentWork == null ? null : (
        <Card title="当前工作">
          <div className={cn("arbor-view-stack", "flex flex-col gap-ui-3")}>
            <span>{res.currentWork.objective}</span>
            <div className={cn("arbor-badge-row", "flex flex-wrap gap-ui-2")}>
              <EnumBadge label={res.currentWork.status} />
              {res.currentWork.workId == null ? null : (
                <Mono>{res.currentWork.workId}</Mono>
              )}
            </div>
            {res.currentWork.activeExecution == null ? null : (
              <div className={cn("arbor-kv", "flex flex-col gap-ui-1")}>
                <span
                  className={cn(
                    "arbor-kv-label",
                    "text-muted-foreground font-sans text-caption",
                  )}
                >
                  activeExecution
                </span>
                <span>
                  <Mono>{res.currentWork.activeExecution.executionId}</Mono>{" "}
                  <TimeText at={res.currentWork.activeExecution.admittedAt} />
                </span>
                {res.currentWork.activeExecution.sandboxPolicy ===
                undefined ? null : (
                  <SandboxPolicySummary
                    policy={res.currentWork.activeExecution.sandboxPolicy}
                  />
                )}
              </div>
            )}
          </div>
        </Card>
      )}
      {res.executionSummary == null ? null : (
        <Card title="执行摘要">
          <span>
            <Mono>{res.executionSummary.executionId}</Mono>{" "}
            <TimeText at={res.executionSummary.admittedAt} />
          </span>
          {res.executionSummary.sandboxPolicy === undefined ? null : (
            <SandboxPolicySummary policy={res.executionSummary.sandboxPolicy} />
          )}
        </Card>
      )}
      <Card title="Pending Works">
        {res.pendingWorks.length === 0 ? (
          <Empty>无待办工作</Empty>
        ) : (
          <ul
            className={cn(
              "arbor-row-list",
              "flex flex-col gap-ui-2 m-0 p-0 list-none",
            )}
          >
            {res.pendingWorks.map((work) => (
              <li
                key={work.workId}
                className={cn(
                  "arbor-pending-row",
                  "flex flex-wrap items-center gap-ui-3 pb-ui-2 border-b border-solid border-border",
                )}
              >
                <Mono>{work.workId}</Mono>
                <span>{work.objective}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Dependencies">
        {res.dependencies.length === 0 ? (
          <Empty>无依赖</Empty>
        ) : (
          <DependencyTable rows={res.dependencies} />
        )}
      </Card>
      <Card title="Inbox 未消费">
        {res.inboxUnconsumed.length === 0 ? (
          <Empty>无未消费条目</Empty>
        ) : (
          <InboxRows rows={res.inboxUnconsumed} />
        )}
      </Card>
      {res.verification == null ? null : (
        <Card title="Verification">
          <VerificationView view={res.verification} />
        </Card>
      )}
      <Card title="Audit Timeline">
        {res.auditTimeline.length === 0 ? (
          <Empty>无审计事件</Empty>
        ) : (
          <table
            className={cn(
              "arbor-table",
              "w-full border-collapse text-small block overflow-x-auto [overscroll-behavior-inline:contain] [&_th]:wrap-anywhere [&_td]:wrap-anywhere [&_th]:p-[var(--arbor-space-1)_var(--arbor-space-2)] [&_th]:border-b [&_th]:border-solid [&_th]:border-border [&_th]:text-muted-foreground [&_th]:font-sans [&_th]:text-caption [&_th]:font-semibold [&_th]:text-left [&_td]:p-ui-2 [&_td]:border-b [&_td]:border-solid [&_td]:border-border [&_td]:text-left [&_td]:[vertical-align:top]",
            )}
          >
            <thead>
              <tr>
                <th scope="col">sequence</th>
                <th scope="col">eventType</th>
                <th scope="col">at</th>
              </tr>
            </thead>
            <tbody>
              {res.auditTimeline.map((entry) => (
                <tr key={String(entry.sequence)}>
                  <td>{String(entry.sequence)}</td>
                  <td>
                    <Mono>{entry.eventType}</Mono>
                  </td>
                  <td>
                    <TimeText at={entry.at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
