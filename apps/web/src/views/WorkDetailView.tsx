import type { WorkDetailRes } from "@arbor/api-contracts";
import { Card } from "../components/Card.js";
import { Empty } from "../components/Empty.js";
import { EnumBadge, TimeText } from "./shared.js";

const verdictLabel = (verdict: string): string =>
  ({ Pass: "通过", Fail: "未通过", Unknown: "无法判断" })[verdict] ?? verdict;

const lifecycleLabel = (view: WorkDetailRes): string => {
  if (view.lifecycle === "Completed") return "已完成";
  if (view.lifecycle === "Cancelled") return "已取消";
  if (view.lifecycle === "Open") {
    return view.acceptedResult === undefined ? "进行中" : "已验收、待完成";
  }
  return view.lifecycle;
};

/** Read-only rendering of the canonical Work Detail projection. */
export function WorkDetailView({ view }: { readonly view: WorkDetailRes }) {
  const accepted = view.acceptedResult;
  return (
    <Card title="工作目标">
      <div className="arbor-view-stack">
        <div className="arbor-badge-row">
          <EnumBadge label={lifecycleLabel(view)} />
        </div>
        <h2>{view.objective}</h2>
        <div className="arbor-kv">
          <span className="arbor-kv-label">背景</span>
          <span>{view.why || <Empty>未提供背景</Empty>}</span>
        </div>
        <div className="arbor-kv">
          <span className="arbor-kv-label">完成标准</span>
          <span>
            {view.completionExpectation || <Empty>未提供完成标准</Empty>}
          </span>
        </div>
        {accepted === undefined ? (
          <Empty>这项工作尚未验收</Empty>
        ) : (
          <section aria-label="验收结果">
            <h3>{view.lifecycle === "Cancelled" ? "历史验收" : "验收结果"}</h3>
            <div className="arbor-badge-row">
              <EnumBadge label={verdictLabel(accepted.verdict)} />
              <span>用户确认</span>
              <TimeText at={accepted.acceptedAt} />
            </div>
          </section>
        )}
      </div>
    </Card>
  );
}
