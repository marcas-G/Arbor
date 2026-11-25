/**
 * verification view: criteriaResults table (required marker + verdict badge),
 * evidenceRefs, acceptance block. Absent verdict/acceptance = blank slot.
 */
import type { VerificationRes } from "@arbor/api-contracts";
import { Badge } from "../components/Badge.js";
import { Empty } from "../components/Empty.js";
import { useCompactLayout } from "../components/useCompactLayout.js";
import { cn } from "../lib/utils.js";
import { EnumBadge, TimeText } from "./shared.js";

const verdictLabel = (verdict: string): string =>
  ({ Pass: "通过", Fail: "未通过", Unknown: "无法判断" })[verdict] ?? verdict;

const criterionVerdictLabel = (verdict: string): string =>
  verdict === "Unknown" ? "未单独记录" : verdictLabel(verdict);

export function VerificationView({ view }: { readonly view: VerificationRes }) {
  const compact = useCompactLayout();
  return (
    <div className={cn("arbor-view-stack", "flex flex-col gap-ui-3")}>
      <div className={cn("arbor-badge-row", "flex flex-wrap gap-ui-2")}>
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
        <ul
          className={cn(
            "arbor-verification-cards",
            "flex flex-col gap-ui-2 m-0 p-0 list-none",
          )}
          aria-label="验证条件"
        >
          {view.criteriaResults.map((result) => (
            <li
              key={result.criterionId}
              className={cn(
                "arbor-verification-card",
                "min-w-0 p-ui-3 border border-solid border-border rounded-md bg-card [&_dl]:grid [&_dl]:grid-cols-2 [&_dl]:gap-ui-2 [&_dl]:m-0 [&_dl_>_div]:min-w-0 [&_dt]:text-muted-foreground [&_dt]:text-caption [&_dd]:m-0 [&_dd]:wrap-anywhere max-[24rem]:[&_dl]:grid-cols-1",
              )}
            >
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
        <table
          className={cn(
            "arbor-table",
            "w-full border-collapse text-small block overflow-x-auto [overscroll-behavior-inline:contain] [&_th]:wrap-anywhere [&_td]:wrap-anywhere [&_th]:p-[var(--arbor-space-1)_var(--arbor-space-2)] [&_th]:border-b [&_th]:border-solid [&_th]:border-border [&_th]:text-muted-foreground [&_th]:font-sans [&_th]:text-caption [&_th]:font-semibold [&_th]:text-left [&_td]:p-ui-2 [&_td]:border-b [&_td]:border-solid [&_td]:border-border [&_td]:text-left [&_td]:[vertical-align:top]",
          )}
        >
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
      <div className={cn("arbor-kv", "flex flex-col gap-ui-1")}>
        <span
          className={cn(
            "arbor-kv-label",
            "text-muted-foreground font-sans text-caption",
          )}
        >
          依据
        </span>
        {view.evidenceRefs.length === 0 ? (
          <Empty>尚未记录依据</Empty>
        ) : (
          <span>已记录 {view.evidenceRefs.length} 条依据</span>
        )}
      </div>
      {view.acceptance == null ? null : (
        <div className={cn("arbor-kv", "flex flex-col gap-ui-1")}>
          <span
            className={cn(
              "arbor-kv-label",
              "text-muted-foreground font-sans text-caption",
            )}
          >
            验收
          </span>
          <span>
            已由用户确认于 <TimeText at={view.acceptance.acceptedAt} />
          </span>
        </div>
      )}
    </div>
  );
}
