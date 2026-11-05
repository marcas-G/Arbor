/**
 * current-work view: single card, or the "无当前工作" empty state. The empty
 * state carries no "go select" action — selection is not a view concern (`02`).
 */
import type { CurrentWorkRes } from "@arbor/api-contracts";
import { navigate } from "../api/router.js";
import { Button } from "../components/Button.js";
import { Card } from "../components/Card.js";
import { Empty } from "../components/Empty.js";
import { EnumBadge, TimeText, workLifecycleLabel } from "./shared.js";

export function CurrentWorkView({
  work,
  projectId,
  workspaceId,
}: {
  readonly work: CurrentWorkRes;
  readonly projectId?: string;
  readonly workspaceId?: string;
}) {
  if (work === null) {
    return <Empty>无当前工作</Empty>;
  }
  return (
    <Card title="当前工作">
      <div className="arbor-view-stack">
        <span>{work.objective}</span>
        <div className="arbor-badge-row">
          <EnumBadge label={workLifecycleLabel(work.status)} />
          <span className="arbor-command-static">状态会随推进自动更新</span>
        </div>
        {work.workId === undefined ||
        projectId === undefined ||
        workspaceId === undefined ? null : (
          <Button
            variant="quiet"
            onClick={() => {
              navigate({
                name: "work",
                projectId,
                workspaceId,
                workId: work.workId as string,
              });
            }}
          >
            查看工作详情
          </Button>
        )}
        {work.activeExecution == null ? null : (
          <div className="arbor-kv">
            <span className="arbor-kv-label">正在运行</span>
            <span>
              自 <TimeText at={work.activeExecution.admittedAt} />
            </span>
          </div>
        )}
      </div>
    </Card>
  );
}
