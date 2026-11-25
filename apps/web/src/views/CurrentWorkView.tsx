/**
 * current-work view: single card, or the "无当前工作" empty state. The empty
 * state carries no "go select" action — selection is not a view concern (`02`).
 */
import type { CurrentWorkRes } from "@arbor/api-contracts";
import { navigate } from "../api/router.js";
import { Button } from "../components/Button.js";
import { Card } from "../components/Card.js";
import { Empty } from "../components/Empty.js";
import { cn } from "../lib/utils.js";
import {
  EnumBadge,
  SandboxPolicySummary,
  TimeText,
  workLifecycleLabel,
} from "./shared.js";

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
      <div className={cn("arbor-view-stack", "flex flex-col gap-ui-3")}>
        <span>{work.objective}</span>
        <div className={cn("arbor-badge-row", "flex flex-wrap gap-ui-2")}>
          <EnumBadge label={workLifecycleLabel(work.status)} />
          <span className={cn("arbor-command-static", "text-subtle")}>
            状态会随推进自动更新
          </span>
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
          <div className={cn("arbor-kv", "flex flex-col gap-ui-1")}>
            <span
              className={cn(
                "arbor-kv-label",
                "text-muted-foreground font-sans text-caption",
              )}
            >
              正在运行
            </span>
            <span>
              自 <TimeText at={work.activeExecution.admittedAt} />
            </span>
            {work.activeExecution.sandboxPolicy === undefined ? null : (
              <SandboxPolicySummary
                policy={work.activeExecution.sandboxPolicy}
              />
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
