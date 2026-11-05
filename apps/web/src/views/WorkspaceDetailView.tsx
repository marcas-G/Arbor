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
import { EnumBadge, Mono, TimeText, workLifecycleLabel } from "./shared.js";
import { VerificationView } from "./VerificationView.js";

type Address = WorkspaceDetailRes["boundary"]["addresses"][number];

function addressText(address: Address): string {
  switch (address._tag) {
    case "FileTree":
      return `项目文件 ${address.path}`;
    case "GitWorktree":
      return `项目代码 ${address.path}${
        address.branch === undefined ? "" : ` @${address.branch}`
      }`;
    case "DatabaseNamespace":
      return `数据空间 ${address.namespace}`;
    case "ExternalResource":
      return `外部连接 ${address.address}`;
    default:
      return JSON.stringify(address) ?? "未命名资源";
  }
}

function auditEventLabel(eventType: string): string {
  return (
    {
      WorkspaceCreated: "责任已创建",
      WorkAssigned: "已安排工作",
      CurrentWorkChanged: "当前工作已更新",
    }[eventType] ?? eventType
  );
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
      <Card title="工作方向">
        <div className="arbor-view-stack">
          <span>{r.purpose}</span>
          <StringList label="负责范围" values={r.ownedResponsibilities} />
          <StringList label="需要完成" values={r.obligations} />
          <StringList label="包含内容" values={r.includes} />
          <StringList label="不包含内容" values={r.excludes} />
          <StringList label="协作接口" values={r.interfaces} />
        </div>
      </Card>
      <Card title="项目资源">
        <div className="arbor-view-stack">
          <div className="arbor-kv">
            <span className="arbor-kv-label">关联状态</span>
            <span>由当前工作方向决定</span>
          </div>
          {res.boundary.addresses.length === 0 ? (
            <Empty>暂未关联项目资源</Empty>
          ) : (
            <details>
              <summary>查看资源位置（{res.boundary.addresses.length}）</summary>
              <ul className="arbor-row-list">
                {res.boundary.addresses.map((address, index) => (
                  <li key={`${address._tag}:${String(index)}`}>
                    <Mono>{addressText(address)}</Mono>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </Card>
      {res.currentWork == null ? null : (
        <Card title="当前工作">
          <div className="arbor-view-stack">
            <span>{res.currentWork.objective}</span>
            <div className="arbor-badge-row">
              <EnumBadge label={workLifecycleLabel(res.currentWork.status)} />
              {res.currentWork.workId == null ? null : <span>当前工作</span>}
            </div>
            {res.currentWork.activeExecution == null ? null : (
              <div className="arbor-kv">
                <span className="arbor-kv-label">正在运行</span>
                <span>
                  自{" "}
                  <TimeText at={res.currentWork.activeExecution.admittedAt} />
                </span>
              </div>
            )}
          </div>
        </Card>
      )}
      {res.executionSummary == null ? null : (
        <Card title="最近一次运行">
          <span>
            已于 <TimeText at={res.executionSummary.admittedAt} /> 开始运行
          </span>
        </Card>
      )}
      <Card title="待办工作">
        {res.pendingWorks.length === 0 ? (
          <Empty>无待办工作</Empty>
        ) : (
          <ul className="arbor-row-list">
            {res.pendingWorks.map((work) => (
              <li key={work.workId} className="arbor-pending-row">
                <span>工作</span>
                <span>{work.objective}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="依赖关系">
        {res.dependencies.length === 0 ? (
          <Empty>无依赖</Empty>
        ) : (
          <DependencyTable rows={res.dependencies} />
        )}
      </Card>
      <Card title="待处理消息">
        {res.inboxUnconsumed.length === 0 ? (
          <Empty>暂无待处理消息</Empty>
        ) : (
          <InboxRows rows={res.inboxUnconsumed} />
        )}
      </Card>
      {res.verification == null ? null : (
        <Card title="验证结果">
          <VerificationView view={res.verification} />
        </Card>
      )}
      <Card title="变更记录">
        {res.auditTimeline.length === 0 ? (
          <Empty>暂无变更记录</Empty>
        ) : (
          <table className="arbor-table">
            <thead>
              <tr>
                <th scope="col">序号</th>
                <th scope="col">变化</th>
                <th scope="col">时间</th>
              </tr>
            </thead>
            <tbody>
              {res.auditTimeline.map((entry) => (
                <tr key={String(entry.sequence)}>
                  <td>{String(entry.sequence)}</td>
                  <td>{auditEventLabel(entry.eventType)}</td>
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
