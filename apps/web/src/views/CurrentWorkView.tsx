/**
 * current-work view: single card, or the "无当前工作" empty state. The empty
 * state carries no "go select" action — selection is not a view concern (`02`).
 */
import type { CurrentWorkRes } from "@arbor/api-contracts";
import { Card } from "../components/Card.js";
import { Empty } from "../components/Empty.js";
import { EnumBadge, Mono, TimeText } from "./shared.js";

export function CurrentWorkView({ work }: { readonly work: CurrentWorkRes }) {
  if (work === null) {
    return <Empty>无当前工作</Empty>;
  }
  return (
    <Card title="当前工作">
      <div className="arbor-view-stack">
        <span>{work.objective}</span>
        <div className="arbor-badge-row">
          <EnumBadge label={work.status} />
          {work.workId == null ? null : <Mono>{work.workId}</Mono>}
        </div>
        {work.activeExecution == null ? null : (
          <div className="arbor-kv">
            <span className="arbor-kv-label">activeExecution</span>
            <span>
              <Mono>{work.activeExecution.executionId}</Mono>{" "}
              <TimeText at={work.activeExecution.admittedAt} />
            </span>
          </div>
        )}
      </div>
    </Card>
  );
}
