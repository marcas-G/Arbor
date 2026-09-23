/**
 * workspace-detail view: full panoramic card group. Pending-work rows are
 * plain lists (NOT selection controls, `02` §4); ID cross-links land with
 * routing in a later task — this layer renders IDs verbatim in mono.
 */
import type { WorkspaceDetailRes } from "@arbor/api-contracts";
import { Card } from "../components/Card.js";
import { Empty } from "../components/Empty.js";
import { DependencyTable } from "./DependencyView.js";
import { InboxRows } from "./InboxView.js";
import { EnumBadge, Mono, TimeText } from "./shared.js";
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
    <div className="arbor-kv">
      <span className="arbor-kv-label">{label}</span>
      <ul className="arbor-row-list">
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
    <div className="arbor-view-stack">
      <Card title="Responsibility">
        <div className="arbor-view-stack">
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
        <div className="arbor-view-stack">
          <div className="arbor-kv">
            <span className="arbor-kv-label">basisResponsibilityRevision</span>
            <Mono>{String(res.boundary.basisResponsibilityRevision)}</Mono>
          </div>
          {res.boundary.addresses.length === 0 ? (
            <Empty>无资源地址</Empty>
          ) : (
            <ul className="arbor-row-list">
              {res.boundary.addresses.map((address, index) => (
                <li key={`${address._tag}:${String(index)}`}>
                  <Mono>{addressText(address)}</Mono>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
      {res.currentWork == null ? null : (
        <Card title="当前工作">
          <div className="arbor-view-stack">
            <span>{res.currentWork.objective}</span>
            <div className="arbor-badge-row">
              <EnumBadge label={res.currentWork.status} />
              {res.currentWork.workId == null ? null : (
                <Mono>{res.currentWork.workId}</Mono>
              )}
            </div>
            {res.currentWork.activeExecution == null ? null : (
              <div className="arbor-kv">
                <span className="arbor-kv-label">activeExecution</span>
                <span>
                  <Mono>{res.currentWork.activeExecution.executionId}</Mono>{" "}
                  <TimeText at={res.currentWork.activeExecution.admittedAt} />
                </span>
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
        </Card>
      )}
      <Card title="Pending Works">
        {res.pendingWorks.length === 0 ? (
          <Empty>无待办工作</Empty>
        ) : (
          <ul className="arbor-row-list">
            {res.pendingWorks.map((work) => (
              <li key={work.workId} className="arbor-pending-row">
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
          <table className="arbor-table">
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
