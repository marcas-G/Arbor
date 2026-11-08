/**
 * verification view: criteriaResults table (required marker + verdict badge),
 * evidenceRefs, acceptance block. Absent verdict/acceptance = blank slot.
 */
import type { VerificationRes } from "@arbor/api-contracts";
import { Badge } from "../components/Badge.js";
import { Empty } from "../components/Empty.js";
import { useCompactLayout } from "../components/useCompactLayout.js";
import { EnumBadge, TimeText } from "./shared.js";

const verdictLabel = (verdict: string): string =>
  ({ Pass: "通过", Fail: "未通过", Unknown: "无法判断" })[verdict] ?? verdict;

const criterionVerdictLabel = (verdict: string): string =>
  verdict === "Unknown" ? "未单独记录" : verdictLabel(verdict);

export function VerificationView({ view }: { readonly view: VerificationRes }) {
  const compact = useCompactLayout();
  return (
    <div className="arbor-view-stack">
      <div className="arbor-badge-row">
        <span>总体结果</span>
        {view.verdict == null ? (
          <Badge tone="attention">尚无结论</Badge>
        ) : (
          <EnumBadge label={verdictLabel(view.verdict)} />
        )}
      </div>
      {view.criteriaResults.length === 0 ? (
        <Empty>尚未设置验证条件</Empty>
      ) : compact ? (
        <ul className="arbor-verification-cards" aria-label="验证条件">
          {view.criteriaResults.map((result) => (
            <li key={result.criterionId} className="arbor-verification-card">
              <dl>
                <div>
                  <dt>要求</dt>
                  <dd>{result.requirement}</dd>
                </div>
                <div>
                  <dt>是否必须</dt>
                  <dd>
                    <Badge tone={result.required ? "branch" : "muted"}>
                      {result.required ? "必须" : "可选"}
                    </Badge>
                  </dd>
                </div>
                <div>
                  <dt>单项记录</dt>
                  <dd>
                    <EnumBadge label={criterionVerdictLabel(result.verdict)} />
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      ) : (
        <table className="arbor-table">
          <thead>
            <tr>
              <th scope="col">要求</th>
              <th scope="col">是否必须</th>
              <th scope="col">单项记录</th>
            </tr>
          </thead>
          <tbody>
            {view.criteriaResults.map((result) => (
              <tr key={result.criterionId}>
                <td>{result.requirement}</td>
                <td>
                  <Badge tone={result.required ? "branch" : "muted"}>
                    {result.required ? "必须" : "可选"}
                  </Badge>
                </td>
                <td>
                  <EnumBadge label={criterionVerdictLabel(result.verdict)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="arbor-kv">
        <span className="arbor-kv-label">依据</span>
        {view.evidenceRefs.length === 0 ? (
          <Empty>尚未记录依据</Empty>
        ) : (
          <span>已记录 {view.evidenceRefs.length} 条依据</span>
        )}
      </div>
      {view.acceptance == null ? null : (
        <div className="arbor-kv">
          <span className="arbor-kv-label">验收</span>
          <span>
            已由用户确认于 <TimeText at={view.acceptance.acceptedAt} />
          </span>
        </div>
      )}
    </div>
  );
}
